# demo-app

Two services, one build loop.

    make setup   # deps
    make ci      # lint + test + image build  (identical to GitHub Actions)
    make up      # run the stack in Docker
    make smoke   # black-box check against the running stack
    make down

No Docker? Same loop without it:

    make up-native && make smoke && make down-native

`services/api`  FastAPI (Python)  -> :8000
`services/web`  Node/TypeScript   -> :3000, calls api over the compose network

## After your first `make setup`

`npm install` writes `services/web/package-lock.json`. Commit it — lockfiles pin
exact transitive versions and are the difference between a reproducible build and
a build that works today:

    git add services/web/package-lock.json && git commit -m "chore: lock npm deps"
