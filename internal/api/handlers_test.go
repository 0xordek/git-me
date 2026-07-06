package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ordek1/git-me/internal/auth"
	"github.com/ordek1/git-me/internal/lfs"
	"github.com/ordek1/git-me/internal/metadata"
	"github.com/ordek1/git-me/internal/storage"
)

func setupTestStores() (storage.ObjectStore, metadata.MetadataStore) {
	return storage.NewInMemoryStore(), metadata.NewInMemoryStore()
}

func TestBatchHandlerUpload(t *testing.T) {
	objStore, metaStore := setupTestStores()
	authenticator := auth.NewBearerToken("test123")
	handler := BatchHandler(objStore, metaStore, authenticator)

	body := `{"operation":"upload","transfers":["basic"],"objects":[{"oid":"a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2","size":1024}]}`
	req := httptest.NewRequest("POST", "/objects/batch", strings.NewReader(body))
	req.Header.Set("Content-Type", lfs.ContentType)
	req.Header.Set("Authorization", "Bearer test123")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d, body = %s", rec.Code, http.StatusOK, rec.Body.String())
	}

	var resp lfs.BatchResponse
	json.Unmarshal(rec.Body.Bytes(), &resp)

	if len(resp.Objects) != 1 {
		t.Fatalf("len(Objects) = %d, want 1", len(resp.Objects))
	}
	if resp.Objects[0].Actions["upload"].Href == "" {
		t.Error("upload href is empty")
	}
}

func TestBatchHandlerUnauthorized(t *testing.T) {
	objStore, metaStore := setupTestStores()
	authenticator := auth.NewBearerToken("correct-token")
	handler := BatchHandler(objStore, metaStore, authenticator)

	body := `{"operation":"upload","transfers":["basic"],"objects":[{"oid":"abc","size":1}]}`
	req := httptest.NewRequest("POST", "/objects/batch", strings.NewReader(body))
	req.Header.Set("Content-Type", lfs.ContentType)
	req.Header.Set("Authorization", "Bearer wrong-token")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}

func TestBatchHandlerInvalidContentType(t *testing.T) {
	objStore, metaStore := setupTestStores()
	authenticator := auth.NewBearerToken("tok")
	handler := BatchHandler(objStore, metaStore, authenticator)

	req := httptest.NewRequest("POST", "/objects/batch", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer tok")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnsupportedMediaType {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusUnsupportedMediaType)
	}
}

func TestBatchHandlerInvalidJSON(t *testing.T) {
	objStore, metaStore := setupTestStores()
	authenticator := auth.NewBearerToken("tok")
	handler := BatchHandler(objStore, metaStore, authenticator)

	req := httptest.NewRequest("POST", "/objects/batch", strings.NewReader(`{invalid`))
	req.Header.Set("Content-Type", lfs.ContentType)
	req.Header.Set("Authorization", "Bearer tok")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestUploadHandler(t *testing.T) {
	objStore, metaStore := setupTestStores()
	authenticator := auth.NewBearerToken("tok")
	handler := UploadHandler(objStore, metaStore, authenticator)

	oid := "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"
	content := []byte("uploaded content")
	req := httptest.NewRequest("PUT", "/objects/"+oid, bytes.NewReader(content))
	req.Header.Set("Authorization", "Bearer tok")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}

	exists, _ := objStore.Exists(context.Background(), oid)
	if !exists {
		t.Fatal("object should exist after upload")
	}

	meta, _ := metaStore.Get(context.Background(), oid)
	if meta.Size != int64(len(content)) {
		t.Errorf("meta.Size = %d, want %d", meta.Size, len(content))
	}
}

func TestUploadHandlerUnauthorized(t *testing.T) {
	objStore, metaStore := setupTestStores()
	authenticator := auth.NewBearerToken("tok")
	handler := UploadHandler(objStore, metaStore, authenticator)

	req := httptest.NewRequest("PUT", "/objects/oid123", bytes.NewReader([]byte("data")))
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}

func TestDownloadHandler(t *testing.T) {
	objStore, metaStore := setupTestStores()
	ctx := context.Background()

	oid := "download-api-1234567890abcdef1234567890abcdef1234567890abcdef1234"
	content := []byte("content to download from API")

	metaStore.Put(ctx, &metadata.ObjectMeta{OID: oid, Size: int64(len(content)), Uploaded: true})
	objStore.Put(ctx, oid, bytes.NewReader(content))

	authenticator := auth.NewBearerToken("tok")
	handler := DownloadHandler(objStore, metaStore, authenticator)

	req := httptest.NewRequest("GET", "/objects/"+oid, nil)
	req.Header.Set("Authorization", "Bearer tok")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d, body = %s", rec.Code, http.StatusOK, rec.Body.String())
	}

	got, _ := io.ReadAll(rec.Body)
	if !bytes.Equal(got, content) {
		t.Errorf("content = %q, want %q", string(got), string(content))
	}

	if rec.Header().Get("Content-Type") != "application/octet-stream" {
		t.Errorf("Content-Type = %q, want application/octet-stream", rec.Header().Get("Content-Type"))
	}
}

func TestDownloadHandlerNotFound(t *testing.T) {
	objStore, metaStore := setupTestStores()
	authenticator := auth.NewBearerToken("tok")
	handler := DownloadHandler(objStore, metaStore, authenticator)

	req := httptest.NewRequest("GET", "/objects/nonexistent-1234567890abcdef1234567890abcdef1234567890ab12", nil)
	req.Header.Set("Authorization", "Bearer tok")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusNotFound)
	}
}
