// Package api provides HTTP handlers for the Git LFS API.
package api

import (
	"encoding/json"
	"net/http"

	"github.com/ordek1/git-me/internal/auth"
	"github.com/ordek1/git-me/internal/lfs"
)

func authMiddleware(authenticator auth.Authenticator, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := authenticator.Authenticate(r); err != nil {
			writeLfsError(w, http.StatusUnauthorized, "authentication required")
			return
		}
		next(w, r)
	}
}

func writeLfsError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", lfs.ContentType)
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(lfs.LfsError{Message: message})
}

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", lfs.ContentType)
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
