# TruckSpot

Expo React Native MVP for finding live food truck locations, menus, hours, and in-app reviews.

## Run locally

1. Install dependencies:
   `npm install`
2. Start Expo:
   `npm start`

## Connect Supabase

1. Create a Supabase project.
2. Run [`supabase/schema.sql`](D:\woi food truck app\truckspot\supabase\schema.sql) in the SQL editor.
3. Copy [`.env.example`](D:\woi food truck app\truckspot\.env.example) to `.env`.
4. Fill in:
   `EXPO_PUBLIC_SUPABASE_URL`
   `EXPO_PUBLIC_SUPABASE_ANON_KEY`
5. Restart Expo.

Without Supabase keys, the app stays in demo mode using seeded trucks.
