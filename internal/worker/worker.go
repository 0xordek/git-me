//go:build tinygo.wasm

// Package worker provides the Cloudflare Worker entrypoint for git-me.
package worker

import (
	"net/http"

	"github.com/ordek1/git-me/internal/api"
	"github.com/ordek1/git-me/internal/auth"
	"github.com/ordek1/git-me/internal/config"
	"github.com/ordek1/git-me/internal/storage"
)

// HandleRequest dispatches incoming HTTP requests to the appropriate handler.
func HandleRequest(w http.ResponseWriter, r *http.Request) {
	cfg, err := config.Load()
	if err != nil {
		http.Error(w, "configuration error", http.StatusInternalServerError)
		return
	}

	authenticator := auth.NewBearerToken(cfg.AuthToken)

	objStore := storage.NewCloudflareR2Store(cfg.R2Bucket)
	metaStore := storage.NewCloudflareKVStore()

	batchHandler := api.BatchHandler(objStore, metaStore, authenticator)
	uploadHandler := api.UploadHandler(objStore, metaStore, authenticator)
	downloadHandler := api.DownloadHandler(objStore, metaStore, authenticator)

	switch {
	case r.URL.Path == "/objects/batch":
		batchHandler(w, r)
	case len(r.URL.Path) > 9 && r.URL.Path[:9] == "/objects/" && r.Method == http.MethodPut:
		uploadHandler(w, r)
	case len(r.URL.Path) > 9 && r.URL.Path[:9] == "/objects/" && r.Method == http.MethodGet:
		downloadHandler(w, r)
	default:
		http.NotFound(w, r)
	}
}
