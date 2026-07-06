// Package auth provides authentication interfaces and implementations for git-me.
package auth

import (
	"errors"
	"net/http"
	"strings"
)

// Authenticator validates incoming HTTP requests.
type Authenticator interface {
	Authenticate(r *http.Request) error
}

var (
	// ErrMissingAuth is returned when no Authorization header is present.
	ErrMissingAuth = errors.New("missing Authorization header")

	// ErrInvalidAuth is returned when credentials are invalid.
	ErrInvalidAuth = errors.New("invalid credentials")
)

type bearerToken struct {
	token string
}

// NewBearerToken creates an Authenticator that checks for a Bearer token
// in the Authorization header.
func NewBearerToken(token string) Authenticator {
	return &bearerToken{token: token}
}

func (b *bearerToken) Authenticate(r *http.Request) error {
	header := r.Header.Get("Authorization")
	if header == "" {
		return ErrMissingAuth
	}
	const prefix = "Bearer "
	if !strings.HasPrefix(header, prefix) {
		return ErrInvalidAuth
	}
	if strings.TrimPrefix(header, prefix) != b.token {
		return ErrInvalidAuth
	}
	return nil
}

type basicAuth struct {
	username string
	password string
}

// NewBasicAuth creates an Authenticator that checks HTTP Basic Auth credentials.
func NewBasicAuth(username, password string) Authenticator {
	return &basicAuth{username: username, password: password}
}

func (b *basicAuth) Authenticate(r *http.Request) error {
	u, p, ok := r.BasicAuth()
	if !ok {
		return ErrMissingAuth
	}
	if u != b.username || p != b.password {
		return ErrInvalidAuth
	}
	return nil
}
