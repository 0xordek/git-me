// Package config provides configuration loading and validation for git-me.
package config

import (
	"errors"
	"os"
	"strings"
)

// Config holds all configuration for the git-me server.
type Config struct {
	AuthToken string
	R2Bucket  string
}

// Load reads configuration from environment variables with sensible defaults.
func Load() (*Config, error) {
	cfg := &Config{
		AuthToken: strings.TrimSpace(os.Getenv("GITME_AUTH_TOKEN")),
		R2Bucket:  stringOrDefault(os.Getenv("GITME_R2_BUCKET"), "git-me-objects"),
	}
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	return cfg, nil
}

// Validate checks that the configuration is usable.
func (c *Config) Validate() error {
	if strings.TrimSpace(c.AuthToken) == "" {
		return errors.New("GITME_AUTH_TOKEN is required and must not be empty")
	}
	if strings.TrimSpace(c.R2Bucket) == "" {
		return errors.New("GITME_R2_BUCKET must not be empty")
	}
	return nil
}

func stringOrDefault(val, defaultVal string) string {
	if val == "" {
		return defaultVal
	}
	return strings.TrimSpace(val)
}
