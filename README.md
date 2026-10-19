# Subotwar

A browser-based two-player sumo robot game. Public lobbies appear live; the host creates a room, a second driver joins, and the host can start or kick the challenger.

## Run locally

1. Create a free project at [supabase.com](https://supabase.com/).
2. Copy `.env.example` to `.env` and fill in the project's URL and anon/publishable key from its API settings.
3. Make sure Realtime is enabled in the Supabase dashboard. This prototype uses public Presence and Broadcast channels and does not need database tables.
4. Run `npm install`, then `npm run dev`.

Open the local URL in two browser windows to try a match. Both windows must use the same Supabase project. Nicknames and lobby presence are temporary: a room disappears when its host disconnects.

## Controls

- Red robot / host: `W`, `A`, `S`, `D`
- Blue robot / challenger: arrow keys
- Drive forward or reverse and turn to push the opponent out of the ring.

## Free deployment

In Cloudflare Pages, connect the GitHub repository and use the `main` branch, build command `npm run build`, and output directory `dist`. Add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` as build environment variables in the Cloudflare project settings. Do not commit `.env`.

This prototype relies on clients for host controls and match simulation, so it is intended for casual play and is not cheat-resistant.