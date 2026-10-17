package ws

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"sync"

	"github.com/coder/websocket"
)

type Event struct {
	Type string `json:"type"`
	ID   string `json:"id,omitempty"`
}

type Hub struct {
	mu      sync.RWMutex
	clients map[*websocket.Conn]struct{}
}

func NewHub() *Hub {
	return &Hub{
		clients: make(map[*websocket.Conn]struct{}),
	}
}

func (h *Hub) HandleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true, // local network, no origin check
	})
	if err != nil {
		log.Printf("ws accept: %v", err)
		return
	}

	h.mu.Lock()
	h.clients[conn] = struct{}{}
	h.mu.Unlock()

	defer func() {
		h.mu.Lock()
		delete(h.clients, conn)
		h.mu.Unlock()
		conn.Close(websocket.StatusNormalClosure, "")
	}()

	// Keep connection alive, read and discard client messages
	for {
		_, _, err := conn.Read(r.Context())
		if err != nil {
			return
		}
	}
}

func (h *Hub) Broadcast(evt Event) {
	data, err := json.Marshal(evt)
	if err != nil {
		log.Printf("ws marshal: %v", err)
		return
	}

	h.mu.RLock()
	defer h.mu.RUnlock()

	for conn := range h.clients {
		err := conn.Write(context.Background(), websocket.MessageText, data)
		if err != nil {
			log.Printf("ws write: %v", err)
		}
	}
}
