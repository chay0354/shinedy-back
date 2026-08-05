# Shinedy API

Express API with Supabase persistence. Deploy to Vercel as serverless.

Uses [`@supabase/server`](https://www.npmjs.com/package/@supabase/server) for admin DB access and JWT verification.

## Env

See `.env.example`. Required for production:

- `USE_DATABASE=true`
- `SUPABASE_URL`
- `SUPABASE_SECRET_KEY` (or legacy `SUPABASE_SERVICE_ROLE_KEY`)
- `SUPABASE_JWKS_URL` — for verifying user JWTs without network calls to auth on every request (recommended on Vercel)
- `CORS_ORIGIN` (frontend URL)

Optional: `SUPABASE_PUBLISHABLE_KEY` if you add publishable-key auth later.

Optional AI skill: `npx skills add supabase/server`

## Database

Run `supabase/migrations/001_initial_schema.sql` in Supabase SQL Editor.

## Commands

```bash
npm install
npm run dev    # local
npm start      # production
```
