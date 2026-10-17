package api

import (
	"database/sql"

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

func (s *Server) Router() *chi.Mux {
	r := chi.NewRouter()
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)

	r.Route("/api", func(r chi.Router) {
		r.Post("/records", s.createRecord)
		r.Get("/records", s.listRecords)
		r.Get("/records/{id}", s.getRecord)
		r.Patch("/records/{id}", s.updateRecord)
		r.Delete("/records/{id}", s.deleteRecord)

		r.Get("/stats", s.getStats)

		r.Get("/tags", s.listTags)
		r.Get("/recipes", s.listRecipes)
		r.Get("/scopes", s.listScopes)

		r.Post("/ingest/text", s.ingestText)
	})

	r.Get("/ws", s.hub.HandleWS)

	return r
}
