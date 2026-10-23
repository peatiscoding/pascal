package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"

	"pascal/internal/pidguard"

	"github.com/bwmarrin/discordgo"
)

var botStartTime = time.Now()

// --- Conversation state ---

type convPhase int

const (
	phaseIdle convPhase = iota
	phasePickRecipe       // waiting for user to pick from multiple matches
	phaseCollectFields    // waiting for user to supply missing fields
)

type conversation struct {
	Phase     convPhase
	Recipe    string           // matched recipe usecase
	Choices   []string         // multiple recipe matches for user to pick
	Text      string           // accumulated user text
	Extracted *extractResponse // partial extraction so far
	ExpiresAt time.Time
}

type convManager struct {
	mu    sync.Mutex
	convs map[string]*conversation // key: channelID:userID
}

func newConvManager() *convManager {
	cm := &convManager{convs: make(map[string]*conversation)}
	go cm.reaper()
	return cm
}

func (cm *convManager) key(channelID, userID string) string {
	return channelID + ":" + userID
}

func (cm *convManager) get(channelID, userID string) *conversation {
	cm.mu.Lock()
	defer cm.mu.Unlock()
	c := cm.convs[cm.key(channelID, userID)]
	if c != nil && time.Now().After(c.ExpiresAt) {
		delete(cm.convs, cm.key(channelID, userID))
		return nil
	}
	return c
}

func (cm *convManager) set(channelID, userID string, c *conversation) {
	cm.mu.Lock()
	defer cm.mu.Unlock()
	c.ExpiresAt = time.Now().Add(5 * time.Minute)
	cm.convs[cm.key(channelID, userID)] = c
}

func (cm *convManager) clear(channelID, userID string) {
	cm.mu.Lock()
	defer cm.mu.Unlock()
	delete(cm.convs, cm.key(channelID, userID))
}

func (cm *convManager) reaper() {
	for {
		time.Sleep(1 * time.Minute)
		cm.mu.Lock()
		now := time.Now()
		for k, c := range cm.convs {
			if now.After(c.ExpiresAt) {
				delete(cm.convs, k)
			}
		}
		cm.mu.Unlock()
	}
}

// --- API response types ---

type matchRecipeResponse struct {
	Matches []string `json:"matches"`
}

type extractResponse struct {
	Title   string        `json:"tl"`
	Detail  *string       `json:"dt,omitempty"`
	Status  int           `json:"st"`
	Scope   string        `json:"sc"`
	Tags    []string      `json:"tags"`
	Values  []recordValue `json:"values"`
	Missing []string      `json:"missing,omitempty"`
}

type recordValue struct {
	Key   string  `json:"k"`
	Value float64 `json:"v"`
}

type createRecordRequest struct {
	Title  string        `json:"tl"`
	Detail *string       `json:"dt,omitempty"`
	Status int           `json:"st"`
	Scope  string        `json:"sc"`
	Recipe *string       `json:"r,omitempty"`
	Tags   []string      `json:"tags"`
	Values []recordValue `json:"values"`
}

// --- Main ---

func main() {
	pidguard.Start("runtime/bot.pid", 5*time.Second)
	token := os.Getenv("DISCORD_TOKEN")
	if token == "" {
		log.Fatal("DISCORD_TOKEN required")
	}

	serverURL := envOr("PASCAL_SERVER_URL", "http://localhost:7600")
	botLogPath := envOr("PASCAL_BOT_LOG", "runtime/bot.log")

	logFile, err := os.OpenFile(botLogPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		log.Fatalf("open bot log: %v", err)
	}
	defer logFile.Close()
	var logMu sync.Mutex

	cm := newConvManager()

	dg, err := discordgo.New("Bot " + token)
	if err != nil {
		log.Fatalf("discord session: %v", err)
	}

	dg.AddHandler(func(s *discordgo.Session, m *discordgo.MessageCreate) {
		if m.Author.ID == s.State.User.ID {
			return
		}

		mention := "<@" + s.State.User.ID + ">"

		// Log all messages
		logContent := strings.ReplaceAll(m.Content, mention, "Pascal")
		logMu.Lock()
		fmt.Fprintf(logFile, "%s | %s | %s | %s\n",
			time.Now().Format(time.RFC3339),
			m.Author.Username,
			m.ChannelID,
			logContent,
		)
		logMu.Unlock()

		// Check for active conversation (no mention needed for follow-up)
		conv := cm.get(m.ChannelID, m.Author.ID)
		if conv != nil {
			text := strings.TrimSpace(strings.ReplaceAll(m.Content, mention, ""))
			if text == "" {
				return
			}
			go handleConversation(s, m, cm, conv, text, serverURL)
			return
		}

		// New messages require mention
		if !strings.Contains(m.Content, mention) {
			return
		}

		text := strings.TrimSpace(strings.ReplaceAll(m.Content, mention, ""))

		// Commands
		if matched, _ := regexp.MatchString(`(?i)^clean\s*up$`, text); matched {
			go cleanupBotMessages(s, m.ChannelID)
			return
		}
		if strings.EqualFold(text, "cancel") {
			cm.clear(m.ChannelID, m.Author.ID)
			s.ChannelMessageSend(m.ChannelID, "Cancelled.")
			return
		}

		if text == "" {
			s.ChannelMessageSend(m.ChannelID, "Send me something to log!")
			return
		}

		// Phase 1: match recipe
		go handleNewMessage(s, m, cm, text, serverURL)
	})

	dg.Identify.Intents = discordgo.IntentsGuildMessages

	if err := dg.Open(); err != nil {
		log.Fatalf("discord open: %v", err)
	}
	defer dg.Close()

	// Health endpoint
	healthAddr := envOr("PASCAL_BOT_HEALTH_ADDR", ":7602")
	go func() {
		mux := http.NewServeMux()
		mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Access-Control-Allow-Origin", "*")
			w.Header().Set("Content-Type", "application/json")
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			fmt.Fprintf(w, `{"status":"ok","uptime_sec":%d}`, int(time.Since(botStartTime).Seconds()))
		})
		log.Printf("pascal bot health on %s", healthAddr)
		http.ListenAndServe(healthAddr, mux)
	}()

	log.Println("pascal bot running")

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	<-sigCh
	log.Println("bot shutting down")
}

// --- Phase 1: New message → match recipe ---

func handleNewMessage(s *discordgo.Session, m *discordgo.MessageCreate, cm *convManager, text, serverURL string) {
	matches, err := apiMatchRecipe(serverURL, text)
	if err != nil {
		s.ChannelMessageSend(m.ChannelID, fmt.Sprintf("Error matching recipe: %v", err))
		return
	}

	switch len(matches) {
	case 0:
		s.ChannelMessageSend(m.ChannelID, "No matching recipe found. Please set up a recipe first.")
	case 1:
		// Single match — proceed to extraction
		handleExtract(s, m, cm, text, matches[0], serverURL)
	default:
		// Multiple matches — ask user to pick
		var msg strings.Builder
		msg.WriteString("Multiple recipes match. Reply with a number:\n")
		for i, r := range matches {
			fmt.Fprintf(&msg, "%d. %s\n", i+1, r)
		}
		s.ChannelMessageSend(m.ChannelID, msg.String())
		cm.set(m.ChannelID, m.Author.ID, &conversation{
			Phase:   phasePickRecipe,
			Choices: matches,
			Text:    text,
		})
	}
}

// --- Phase 2: Extract fields with recipe context ---

func handleExtract(s *discordgo.Session, m *discordgo.MessageCreate, cm *convManager, text, recipe, serverURL string) {
	result, err := apiExtract(serverURL, text, recipe)
	if err != nil {
		s.ChannelMessageSend(m.ChannelID, fmt.Sprintf("Error extracting: %v", err))
		cm.clear(m.ChannelID, m.Author.ID)
		return
	}

	if len(result.Missing) > 0 {
		var msg strings.Builder
		msg.WriteString("I need more info. Please provide:\n")
		for _, f := range result.Missing {
			fmt.Fprintf(&msg, "- %s\n", f)
		}
		s.ChannelMessageSend(m.ChannelID, msg.String())
		cm.set(m.ChannelID, m.Author.ID, &conversation{
			Phase:     phaseCollectFields,
			Recipe:    recipe,
			Text:      text,
			Extracted: result,
		})
		return
	}

	// All fields present — create record
	err = apiCreateRecord(serverURL, result, recipe)
	if err != nil {
		s.ChannelMessageSend(m.ChannelID, fmt.Sprintf("Error creating record: %v", err))
	} else {
		summary := fmt.Sprintf("Recorded: **%s**", result.Title)
		if len(result.Values) > 0 {
			parts := make([]string, len(result.Values))
			for i, v := range result.Values {
				parts[i] = fmt.Sprintf("%s=%.2f", v.Key, v.Value)
			}
			summary += " (" + strings.Join(parts, ", ") + ")"
		}
		s.ChannelMessageSend(m.ChannelID, summary)
	}
	cm.clear(m.ChannelID, m.Author.ID)
}

// --- Handle follow-up messages in active conversation ---

func handleConversation(s *discordgo.Session, m *discordgo.MessageCreate, cm *convManager, conv *conversation, text, serverURL string) {
	if strings.EqualFold(text, "cancel") {
		cm.clear(m.ChannelID, m.Author.ID)
		s.ChannelMessageSend(m.ChannelID, "Cancelled.")
		return
	}

	switch conv.Phase {
	case phasePickRecipe:
		// User should reply with a number
		var pick int
		if _, err := fmt.Sscanf(text, "%d", &pick); err != nil || pick < 1 || pick > len(conv.Choices) {
			s.ChannelMessageSend(m.ChannelID, fmt.Sprintf("Pick a number 1-%d, or say cancel.", len(conv.Choices)))
			return
		}
		recipe := conv.Choices[pick-1]
		handleExtract(s, m, cm, conv.Text, recipe, serverURL)

	case phaseCollectFields:
		// Append new info and re-extract
		combined := conv.Text + "\n" + text
		handleExtract(s, m, cm, combined, conv.Recipe, serverURL)
	}
}

// --- API helpers ---

func apiMatchRecipe(serverURL, text string) ([]string, error) {
	body, _ := json.Marshal(map[string]string{"text": text})
	resp, err := http.Post(serverURL+"/api/infer/match-recipe", "application/json", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("server %d: %s", resp.StatusCode, string(b))
	}

	var result matchRecipeResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, err
	}
	return result.Matches, nil
}

func apiExtract(serverURL, text, recipe string) (*extractResponse, error) {
	body, _ := json.Marshal(map[string]string{"text": text, "recipe": recipe})
	resp, err := http.Post(serverURL+"/api/infer/extract", "application/json", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("server %d: %s", resp.StatusCode, string(b))
	}

	var result extractResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, err
	}
	return &result, nil
}

func apiCreateRecord(serverURL string, ext *extractResponse, recipe string) error {
	req := createRecordRequest{
		Title:  ext.Title,
		Detail: ext.Detail,
		Status: ext.Status,
		Scope:  ext.Scope,
		Recipe: &recipe,
		Tags:   ext.Tags,
		Values: ext.Values,
	}
	body, _ := json.Marshal(req)
	resp, err := http.Post(serverURL+"/api/records", "application/json", bytes.NewReader(body))
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("server %d: %s", resp.StatusCode, string(b))
	}
	return nil
}

// --- Utilities ---

func cleanupBotMessages(s *discordgo.Session, channelID string) {
	botID := s.State.User.ID
	deleted := 0
	beforeID := ""

	for {
		msgs, err := s.ChannelMessages(channelID, 100, beforeID, "", "")
		if err != nil || len(msgs) == 0 {
			break
		}
		for _, msg := range msgs {
			if msg.Author.ID == botID {
				s.ChannelMessageDelete(channelID, msg.ID)
				deleted++
				time.Sleep(500 * time.Millisecond)
			}
			beforeID = msg.ID
		}
	}

	s.ChannelMessageSend(channelID, fmt.Sprintf("Cleaned up %d messages.", deleted))
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
