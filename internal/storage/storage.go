// Package storage provides the object store interface and types for git-me binary objects.
package storage

import (
	"bytes"
	"context"
	"errors"
	"io"
	"sync"
)

// ObjectStore is the interface for binary object persistence.
type ObjectStore interface {
	Put(ctx context.Context, oid string, reader io.Reader) error
	Get(ctx context.Context, oid string) (io.ReadCloser, error)
	Exists(ctx context.Context, oid string) (bool, error)
}

// ErrNotFound is returned when a binary object is not found.
var ErrNotFound = errors.New("storage: object not found")

type inMemoryStore struct {
	mu    sync.RWMutex
	blobs map[string][]byte
}

// NewInMemoryStore creates an ObjectStore backed by memory. Intended for testing.
func NewInMemoryStore() ObjectStore {
	return &inMemoryStore{blobs: make(map[string][]byte)}
}

func (s *inMemoryStore) Put(ctx context.Context, oid string, reader io.Reader) error {
	data, err := io.ReadAll(reader)
	if err != nil {
		return err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	clone := make([]byte, len(data))
	copy(clone, data)
	s.blobs[oid] = clone
	return nil
}

func (s *inMemoryStore) Get(ctx context.Context, oid string) (io.ReadCloser, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	data, ok := s.blobs[oid]
	if !ok {
		return nil, ErrNotFound
	}

	return io.NopCloser(bytes.NewReader(data)), nil
}

func (s *inMemoryStore) Exists(ctx context.Context, oid string) (bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	_, ok := s.blobs[oid]
	return ok, nil
}
