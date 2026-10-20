package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/bwmarrin/discordgo"
)

var botStartTime = time.Now()

func main() {
	token := os.Getenv("DISCORD_TOKEN")
	if token == "" {
		log.Fatal("DISCORD_TOKEN required")
	}

	serverURL := envOr("PASCAL_SERVER_URL", "http://localhost:7600")

	dg, err := discordgo.New("Bot " + token)
	if err != nil {
		log.Fatalf("discord session: %v", err)
	}

	dg.AddHandler(func(s *discordgo.Session, m *discordgo.MessageCreate) {
		if m.Author.ID == s.State.User.ID {
			return
		}

		// Respond to mentions
		if !strings.Contains(m.Content, "<@"+s.State.User.ID+">") {
			return
		}

		text := strings.TrimSpace(
			strings.ReplaceAll(m.Content, "<@"+s.State.User.ID+">", ""),
		)
		if text == "" {
			s.ChannelMessageSend(m.ChannelID, "Send me something to log!")
			return
		}

		queueID, err := ingest(serverURL, text)
		if err != nil {
			s.ChannelMessageSend(m.ChannelID, fmt.Sprintf("Error: %v", err))
			return
		}

		s.ChannelMessageSend(m.ChannelID, fmt.Sprintf("Queued (#%d). Processing...", queueID))
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

type ingestReq struct {
	Text   string `json:"text"`
	Source string `json:"source"`
}

type ingestResp struct {
	QueueID int64 `json:"queue_id"`
}

func ingest(serverURL, text string) (int64, error) {
	body, _ := json.Marshal(ingestReq{Text: text, Source: "discord"})
	resp, err := http.Post(serverURL+"/api/ingest/text", "application/json", bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusAccepted {
		return 0, fmt.Errorf("server returned %d", resp.StatusCode)
	}

	var result ingestResp
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return 0, err
	}
	return result.QueueID, nil
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
