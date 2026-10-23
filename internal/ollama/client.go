package ollama

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

type Client struct {
	BaseURL string
	Model   string
}

func New(baseURL, model string) *Client {
	if baseURL == "" {
		baseURL = "http://localhost:11434"
	}
	if model == "" {
		model = "qwen2.5:7b"
	}
	return &Client{BaseURL: baseURL, Model: model}
}

type generateRequest struct {
	Model  string `json:"model"`
	Prompt string `json:"prompt"`
	Stream bool   `json:"stream"`
	Format string `json:"format"`
}

type generateResponse struct {
	Response string `json:"response"`
}

// Generate sends a prompt to Ollama and returns the response text.
func (c *Client) Generate(prompt string) (string, error) {
	body, err := json.Marshal(generateRequest{
		Model:  c.Model,
		Prompt: prompt,
		Stream: false,
		Format: "json",
	})
	if err != nil {
		return "", err
	}

	resp, err := http.Post(c.BaseURL+"/api/generate", "application/json", bytes.NewReader(body))
	if err != nil {
		return "", fmt.Errorf("ollama request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("ollama %d: %s", resp.StatusCode, string(b))
	}

	var result generateResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", fmt.Errorf("ollama decode: %w", err)
	}

	return result.Response, nil
}
