//go:build tinygo.wasm

package storage

import (
	"context"
	"errors"
	"io"
)

var ErrNotAvailable = errors.New("storage: Cloudflare R2 not available in this environment")

// NewCloudflareR2Store creates an ObjectStore backed by Cloudflare R2.
func NewCloudflareR2Store(bucket string) ObjectStore {
	return &r2Store{bucket: bucket}
}

type r2Store struct {
	bucket string
}

func (s *r2Store) Put(ctx context.Context, oid string, reader io.Reader) error {
	return ErrNotAvailable
}

func (s *r2Store) Get(ctx context.Context, oid string) (io.ReadCloser, error) {
	return nil, ErrNotAvailable
}

func (s *r2Store) Exists(ctx context.Context, oid string) (bool, error) {
	return false, ErrNotAvailable
}
