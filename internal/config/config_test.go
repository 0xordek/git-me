package config

import (
	"os"
	"testing"
)

func TestLoadFromEnv(t *testing.T) {
	os.Setenv("GITME_AUTH_TOKEN", "test-token-123")
	os.Setenv("GITME_R2_BUCKET", "my-bucket")
	defer os.Unsetenv("GITME_AUTH_TOKEN")
	defer os.Unsetenv("GITME_R2_BUCKET")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.AuthToken != "test-token-123" {
		t.Errorf("AuthToken = %q, want %q", cfg.AuthToken, "test-token-123")
	}
	if cfg.R2Bucket != "my-bucket" {
		t.Errorf("R2Bucket = %q, want %q", cfg.R2Bucket, "my-bucket")
	}
}

func TestLoadDefaults(t *testing.T) {
	os.Unsetenv("GITME_AUTH_TOKEN")
	os.Unsetenv("GITME_R2_BUCKET")
	os.Setenv("GITME_AUTH_TOKEN", "tok")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.R2Bucket != "git-me-objects" {
		t.Errorf("R2Bucket default = %q, want %q", cfg.R2Bucket, "git-me-objects")
	}
}

func TestLoadWhitespaceR2BucketRejected(t *testing.T) {
	os.Setenv("GITME_AUTH_TOKEN", "tok")
	os.Setenv("GITME_R2_BUCKET", "   ")
	defer os.Unsetenv("GITME_AUTH_TOKEN")
	defer os.Unsetenv("GITME_R2_BUCKET")

	_, err := Load()
	if err == nil {
		t.Fatal("Load() expected error for whitespace-only R2 bucket")
	}
}

func TestValidateMissingAuthToken(t *testing.T) {
	cfg := &Config{AuthToken: "", R2Bucket: "b"}
	err := cfg.Validate()
	if err == nil {
		t.Fatal("Validate() expected error for empty AuthToken")
	}
}

func TestValidateEmptyAuthToken(t *testing.T) {
	cfg := &Config{AuthToken: "   ", R2Bucket: "b"}
	err := cfg.Validate()
	if err == nil {
		t.Fatal("Validate() expected error for whitespace-only AuthToken")
	}
}

func TestValidateOK(t *testing.T) {
	cfg := &Config{AuthToken: "tok", R2Bucket: "b"}
	if err := cfg.Validate(); err != nil {
		t.Errorf("Validate() error = %v, want nil", err)
	}
}
