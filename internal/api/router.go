package api

import (
	"database/sql"
	"net/http"

	"pascal/internal/ws"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

type Server struct {
	mainDB  *sql.DB
	queueDB *sql.DB
	hub     *ws.Hub
}

func NewServer(mainDB, queueDB *sql.DB, hub *ws.Hub) *Server {
	return &Server{mainDB: mainDB, queueDB: queueDB, hub: hub}
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

		r.Post("/records", s.createRecord)
		r.Get("/records", s.listRecords)
		r.Get("/records/{id}", s.getRecord)
		r.Patch("/records/{id}", s.updateRecord)
		r.Delete("/records/{id}", s.deleteRecord)

		r.Get("/stats", s.getStats)

		r.Get("/tags", s.listTags)
		r.Get("/scopes", s.listScopes)
		r.Get("/master-values", s.listMasterValues)

		r.Get("/recipes", s.listRecipesFull)
		r.Get("/recipes/{u}", s.getRecipe)
		r.Post("/recipes", s.createRecipe)
		r.Put("/recipes/{u}", s.updateRecipe)
		r.Delete("/recipes/{u}", s.deleteRecipe)

		r.Post("/ingest/text", s.ingestText)
	})

	r.Get("/ws", s.hub.HandleWS)

	return r
}
