//go:build tinygo.wasm

package metadata

import (
	"context"
	"errors"
)

var ErrNotAvailable = errors.New("metadata: Cloudflare KV not available in this environment")

// NewCloudflareKVStore creates a MetadataStore backed by Cloudflare KV.
func NewCloudflareKVStore() MetadataStore {
	return &kvStore{}
}

type kvStore struct{}

func (s *kvStore) Get(ctx context.Context, oid string) (*ObjectMeta, error) {
	return nil, ErrNotAvailable
}

func (s *kvStore) Put(ctx context.Context, meta *ObjectMeta) error {
	return ErrNotAvailable
}
