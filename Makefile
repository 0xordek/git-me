.PHONY: build test test-cover dev deploy clean fmt lint js-test verify

build:
	node -e "require('node:fs').mkdirSync('build', { recursive: true })"
	tinygo build -tags tinygo.wasm -o build/git-me.wasm -target wasm -no-debug ./cmd/worker/

test:
	go test -v -race -count=1 ./...

js-test:
	npm test

test-cover:
	go test -v -race -count=1 -coverprofile=coverage.out ./...
	go tool cover -html=coverage.out -o coverage.html

dev: build
	wrangler dev

deploy: build
	wrangler deploy

fmt:
	go fmt ./...

lint:
	go vet ./...

verify: test lint js-test build
	wrangler deploy --dry-run

clean:
	rm -rf build/ dist/ coverage.out coverage.html
