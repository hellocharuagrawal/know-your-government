# Know Your Government

A civic engagement app for exploring India's central government — departments, the Lok Sabha,
the Council of Ministers, party manifestos, and how the system fits together.

## Structure
- `frontend/` — the app itself (currently a single-file HTML app)
- `backend/` — a small proxy server that fetches live data from india.gov.in server-side,
  avoiding the browser CORS restriction, and serves it to the frontend

## Status
Frontend is functional with a mix of live data (World Bank economic indicators) and
verified static data (227+ MPs, 72 ministers, manifestos). Backend proxy is in progress
to make MP/minister data live instead of static.
