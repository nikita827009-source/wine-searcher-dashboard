# SETUP
```
cd winesearcher/wine-scraper
cp .env.example .env      # set ADMIN_TOKEN
npm install
npx prisma migrate dev
npm run import            # validates + imports wine_dataset.json (idempotent)
npm start                 # http://localhost:5000
npm test
```
