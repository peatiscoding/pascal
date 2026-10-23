package api

import (
	"database/sql"
	"net/http"

	"pascal/internal/ollama"
	"pascal/internal/ws"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

type Server struct {
	mainDB     *sql.DB
	queueDB    *sql.DB
	hub        *ws.Hub
	ollama     *ollama.Client
	botLogPath string
}

func NewServer(mainDB, queueDB *sql.DB, hub *ws.Hub, oc *ollama.Client, botLogPath string) *Server {
	return &Server{mainDB: mainDB, queueDB: queueDB, hub: hub, ollama: oc, botLogPath: botLogPath}
}

func cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) Router() *chi.Mux {
	r := chi.NewRouter()
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	r.Use(cors)

	r.Route("/api", func(r chi.Router) {
		r.Get("/health", s.health)
		r.Get("/mcp/probe", s.mcpProbe)
		r.Get("/logs/bot", s.streamBotLog)

		r.Post("/records", s.createRecord)
		r.Get("/records", s.listRecords)
		r.Get("/records/{id}", s.getRecord)
		r.Patch("/records/{id}", s.updateRecord)
		r.Delete("/records/{id}", s.deleteRecord)

		r.Get("/stats", s.getStats)

		r.Get("/tags", s.listTags)
		r.Post("/tags", s.createTag)
		r.Put("/tags/{t}", s.updateTag)
		r.Delete("/tags/{t}", s.deleteTag)

		r.Get("/scopes", s.listScopes)
		r.Post("/scopes", s.createScope)
		r.Put("/scopes/{id}", s.updateScope)
		r.Delete("/scopes/{id}", s.deleteScope)

		r.Get("/master-values", s.listMasterValues)
		r.Post("/master-values", s.createMasterValue)
		r.Put("/master-values/{k}", s.updateMasterValue)
		r.Delete("/master-values/{k}", s.deleteMasterValue)

		r.Get("/recipes", s.listRecipesFull)
		r.Get("/recipes/{u}", s.getRecipe)
		r.Post("/recipes", s.createRecipe)
		r.Put("/recipes/{u}", s.updateRecipe)
		r.Delete("/recipes/{u}", s.deleteRecipe)

		r.Route("/ingest", func(r chi.Router) {
			r.Post("/text", s.ingestText)
			r.Post("/record", s.createRecord)
			r.Post("/webhook/{id}", s.handleWebhook)
		})
	})

	r.Get("/ws", s.hub.HandleWS)

	return r
}
