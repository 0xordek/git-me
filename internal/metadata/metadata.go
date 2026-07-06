// Package metadata provides the metadata store interface and types for git-me objects.
package metadata

import (
	"context"
	"errors"
	"sync"
	"time"
)

// ObjectMeta represents metadata about a stored Git LFS object.
type ObjectMeta struct {
	OID       string    `json:"oid"`
	Size      int64     `json:"size"`
	CreatedAt time.Time `json:"created_at"`
	Uploaded  bool      `json:"uploaded"`
}

// MetadataStore is the interface for object metadata persistence.
type MetadataStore interface {
	Get(ctx context.Context, oid string) (*ObjectMeta, error)
	Put(ctx context.Context, meta *ObjectMeta) error
}

// ErrNotFound is returned when a metadata entry is not found.
var ErrNotFound = errors.New("metadata: object not found")

type inMemoryStore struct {
	mu   sync.RWMutex
	data map[string]*ObjectMeta
}

// NewInMemoryStore creates a MetadataStore backed by memory. Intended for testing.
func NewInMemoryStore() MetadataStore {
	return &inMemoryStore{data: make(map[string]*ObjectMeta)}
}

func (s *inMemoryStore) Get(ctx context.Context, oid string) (*ObjectMeta, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	meta, ok := s.data[oid]
	if !ok {
		return nil, ErrNotFound
	}
	cpy := *meta
	return &cpy, nil
}

func (s *inMemoryStore) Put(ctx context.Context, meta *ObjectMeta) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	cpy := *meta
	s.data[meta.OID] = &cpy
	return nil
}
