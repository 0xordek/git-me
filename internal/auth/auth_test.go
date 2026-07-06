package auth

import (
	"net/http"
	"testing"
)

func TestBearerTokenAuthenticateValid(t *testing.T) {
	a := NewBearerToken("secret-token")
	req, _ := http.NewRequest("GET", "/", nil)
	req.Header.Set("Authorization", "Bearer secret-token")

	if err := a.Authenticate(req); err != nil {
		t.Errorf("Authenticate() error = %v, want nil", err)
	}
}

func TestBearerTokenAuthenticateMissingHeader(t *testing.T) {
	a := NewBearerToken("secret-token")
	req, _ := http.NewRequest("GET", "/", nil)

	err := a.Authenticate(req)
	if err == nil {
		t.Fatal("expected error for missing Authorization header")
	}
}

func TestBearerTokenAuthenticateWrongToken(t *testing.T) {
	a := NewBearerToken("secret-token")
	req, _ := http.NewRequest("GET", "/", nil)
	req.Header.Set("Authorization", "Bearer wrong-token")

	err := a.Authenticate(req)
	if err == nil {
		t.Fatal("expected error for wrong token")
	}
}

func TestBearerTokenAuthenticateMalformedHeader(t *testing.T) {
	a := NewBearerToken("secret-token")
	req, _ := http.NewRequest("GET", "/", nil)
	req.Header.Set("Authorization", "NotBearer token")

	err := a.Authenticate(req)
	if err == nil {
		t.Fatal("expected error for malformed Authorization header")
	}
}

func TestBasicAuthAuthenticateValid(t *testing.T) {
	a := NewBasicAuth("admin", "pass123")
	req, _ := http.NewRequest("GET", "/", nil)
	req.SetBasicAuth("admin", "pass123")

	if err := a.Authenticate(req); err != nil {
		t.Errorf("Authenticate() error = %v, want nil", err)
	}
}

func TestBasicAuthAuthenticateWrongPassword(t *testing.T) {
	a := NewBasicAuth("admin", "pass123")
	req, _ := http.NewRequest("GET", "/", nil)
	req.SetBasicAuth("admin", "wrong")

	err := a.Authenticate(req)
	if err == nil {
		t.Fatal("expected error for wrong password")
	}
}

func TestBasicAuthAuthenticateMissingHeader(t *testing.T) {
	a := NewBasicAuth("admin", "pass123")
	req, _ := http.NewRequest("GET", "/", nil)

	err := a.Authenticate(req)
	if err == nil {
		t.Fatal("expected error for missing Authorization header")
	}
}
