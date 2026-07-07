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

	"github.com/0xordek/git-me/internal/auth"
	"github.com/0xordek/git-me/internal/lfs"
	"github.com/0xordek/git-me/internal/metadata"
	"github.com/0xordek/git-me/internal/storage"
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

func TestBatchHandlerAcceptsContentTypeWithCharset(t *testing.T) {
	objStore, metaStore := setupTestStores()
	handler := BatchHandler(objStore, metaStore, auth.NewBearerToken("tok"))
	body := `{"operation":"upload","transfers":["basic"],"objects":[{"oid":"a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2","size":1}]}`
	req := httptest.NewRequest(http.MethodPost, "/objects/batch", strings.NewReader(body))
	req.Header.Set("Content-Type", lfs.ContentType+"; charset=utf-8")
	req.Header.Set("Authorization", "Bearer tok")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d, body = %s", rec.Code, http.StatusOK, rec.Body.String())
	}
}

func TestBatchHandlerMethodNotAllowed(t *testing.T) {
	objStore, metaStore := setupTestStores()
	handler := BatchHandler(objStore, metaStore, auth.NewBearerToken("tok"))
	req := httptest.NewRequest(http.MethodGet, "/objects/batch", nil)
	req.Header.Set("Authorization", "Bearer tok")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusMethodNotAllowed)
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

func TestUploadHandlerMethodNotAllowed(t *testing.T) {
	objStore, metaStore := setupTestStores()
	handler := UploadHandler(objStore, metaStore, auth.NewBearerToken("tok"))
	oid := "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"
	req := httptest.NewRequest(http.MethodGet, "/objects/"+oid, nil)
	req.Header.Set("Authorization", "Bearer tok")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusMethodNotAllowed)
	}
}

func TestUploadHandlerMissingOID(t *testing.T) {
	objStore, metaStore := setupTestStores()
	handler := UploadHandler(objStore, metaStore, auth.NewBearerToken("tok"))
	req := httptest.NewRequest(http.MethodPut, "/objects/", strings.NewReader("data"))
	req.Header.Set("Authorization", "Bearer tok")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusBadRequest)
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

func TestDownloadHandlerMissingOID(t *testing.T) {
	objStore, metaStore := setupTestStores()
	handler := DownloadHandler(objStore, metaStore, auth.NewBearerToken("tok"))
	req := httptest.NewRequest(http.MethodGet, "/objects/", nil)
	req.Header.Set("Authorization", "Bearer tok")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestDownloadHandlerMethodNotAllowed(t *testing.T) {
	objStore, metaStore := setupTestStores()
	handler := DownloadHandler(objStore, metaStore, auth.NewBearerToken("tok"))
	oid := "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"
	req := httptest.NewRequest(http.MethodPut, "/objects/"+oid, nil)
	req.Header.Set("Authorization", "Bearer tok")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusMethodNotAllowed)
	}
}

func TestDownloadHandlerSetsContentLength(t *testing.T) {
	objStore, metaStore := setupTestStores()
	ctx := context.Background()
	oid := "b1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"
	content := []byte("download content")
	_ = metaStore.Put(ctx, &metadata.ObjectMeta{OID: oid, Size: int64(len(content)), Uploaded: true})
	_ = objStore.Put(ctx, oid, bytes.NewReader(content))
	handler := DownloadHandler(objStore, metaStore, auth.NewBearerToken("tok"))
	req := httptest.NewRequest(http.MethodGet, "/objects/"+oid, nil)
	req.Header.Set("Authorization", "Bearer tok")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Header().Get("Content-Length") != "16" {
		t.Fatalf("Content-Length = %q, want 16", rec.Header().Get("Content-Length"))
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

func TestUnauthorizedResponseUsesLFSContentType(t *testing.T) {
	objStore, metaStore := setupTestStores()
	handler := BatchHandler(objStore, metaStore, auth.NewBearerToken("tok"))
	req := httptest.NewRequest(http.MethodPost, "/objects/batch", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", lfs.ContentType)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
	if rec.Header().Get("Content-Type") != lfs.ContentType {
		t.Fatalf("Content-Type = %q, want %q", rec.Header().Get("Content-Type"), lfs.ContentType)
	}
}
