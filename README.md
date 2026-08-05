# Shinedy API

Express API with Supabase persistence. Deploy to Vercel as serverless.

## Env

See `.env.example`. Required for production:

- `USE_DATABASE=true`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `CORS_ORIGIN` (frontend URL)

## Database

Run `supabase/migrations/001_initial_schema.sql` in Supabase SQL Editor.

## Commands

```bash
npm install
npm run dev    # local
npm start      # production
```
