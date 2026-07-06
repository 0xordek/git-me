.PHONY: build test test-cover dev deploy clean fmt lint

build:
	tinygo build -o build/git-me.wasm -target wasm -no-debug ./cmd/worker/

test:
	go test -v -race -count=1 ./...

test-cover:
	go test -v -race -count=1 -coverprofile=coverage.out ./...
	go tool cover -html=coverage.out -o coverage.html

dev:
	wrangler dev

deploy:
	wrangler deploy

fmt:
	go fmt ./...

lint:
	go vet ./...

clean:
	rm -rf build/ dist/ coverage.out coverage.html
