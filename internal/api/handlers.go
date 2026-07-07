package api

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/ordek1/git-me/internal/auth"
	"github.com/ordek1/git-me/internal/lfs"
	"github.com/ordek1/git-me/internal/metadata"
	"github.com/ordek1/git-me/internal/storage"
)

// BatchHandler returns an http.HandlerFunc that processes Git LFS batch requests.
func BatchHandler(
	store storage.ObjectStore,
	metaStore metadata.MetadataStore,
	authenticator auth.Authenticator,
) http.HandlerFunc {
	return authMiddleware(authenticator, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeLfsError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		if !lfs.IsLFSContentType(r.Header.Get("Content-Type")) {
			writeLfsError(w, http.StatusUnsupportedMediaType, "content type must be "+lfs.ContentType)
			return
		}

		var req lfs.BatchRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeLfsError(w, http.StatusBadRequest, "invalid JSON")
			return
		}

		resp, err := lfs.HandleBatch(r.Context(), &req, store, metaStore)
		if err != nil {
			writeLfsError(w, http.StatusBadRequest, err.Error())
			return
		}

		writeJSON(w, http.StatusOK, resp)
	})
}

// UploadHandler returns an http.HandlerFunc that handles object uploads.
func UploadHandler(
	store storage.ObjectStore,
	metaStore metadata.MetadataStore,
	authenticator auth.Authenticator,
) http.HandlerFunc {
	return authMiddleware(authenticator, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut {
			writeLfsError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}

		oid := strings.TrimPrefix(r.URL.Path, "/objects/")
		if oid == "" || oid == r.URL.Path {
			writeLfsError(w, http.StatusBadRequest, "missing OID in URL")
			return
		}

		if err := lfs.HandleUpload(r.Context(), oid, r.Body, store, metaStore); err != nil {
			writeLfsError(w, http.StatusInternalServerError, "upload failed")
			return
		}

		w.WriteHeader(http.StatusOK)
	})
}

// DownloadHandler returns an http.HandlerFunc that handles object downloads.
func DownloadHandler(
	store storage.ObjectStore,
	metaStore metadata.MetadataStore,
	authenticator auth.Authenticator,
) http.HandlerFunc {
	return authMiddleware(authenticator, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			writeLfsError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}

		oid := strings.TrimPrefix(r.URL.Path, "/objects/")
		if oid == "" || oid == r.URL.Path {
			writeLfsError(w, http.StatusBadRequest, "missing OID in URL")
			return
		}

		reader, size, err := lfs.HandleDownload(r.Context(), oid, store, metaStore)
		if err != nil {
			writeLfsError(w, http.StatusNotFound, err.Error())
			return
		}
		defer reader.Close()

		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Length", fmt.Sprintf("%d", size))
		w.WriteHeader(http.StatusOK)
		io.Copy(w, reader)
	})
}
