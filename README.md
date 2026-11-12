# খেজুর ঘর — landing page ও order inbox

## Local test (Windows)

PowerShell-এ এই folder-এ গিয়ে চালান:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\server.ps1
```

প্রথমবার অন্তত ১২ অক্ষরের admin password চাইবে। পেজ: <http://127.0.0.1:5080/>; inbox: <http://127.0.0.1:5080/admin> (username `admin`)। সার্ভার বন্ধ করতে `Ctrl+C` চাপুন। Local demo-র অর্ডার `App_Data\orders.json`-এ থাকে।

## Public deployment (GitHub + Cloudflare Pages + D1)

The PowerShell server is only for local testing. The Cloudflare Pages Functions and D1 database below provide the public HTTPS order API and persistent order storage. GitHub Pages alone cannot run this backend.

### Accounts and source repository

1. Create a GitHub account at <https://github.com/>.
2. Install [GitHub Desktop](https://desktop.github.com/), choose **File > Add Local Repository**, and select this project folder. If it is not a repository yet, choose the option to create one here. Then choose **Publish repository**, name it `khejur-ghor`, keep it **private**, and publish. `.gitignore` excludes local orders and build files.
3. Create a Cloudflare account at <https://dash.cloudflare.com/sign-up> and open **Workers & Pages**.

Do not upload `App_Data\orders.json` manually. Never commit admin passwords, API tokens, customer records, or `.dev.vars`.

### Create the database

1. In Cloudflare, open **Storage & databases > D1 SQL Database**, create a database named `khejur-ghor-orders`.
2. Open the database **Console**, paste and run the contents of `migrations\0001_create_orders.sql`.

### Connect and build the Pages project

1. In **Workers & Pages**, choose **Create application > Pages > Connect to Git**, authorize GitHub, and select the private repository.
2. Set **Build command** to `npm run build` and **Build output directory** to `dist`; deploy the project.
3. In the Pages project, open **Settings > Bindings > Add > D1 database**. Set the variable name to `DB`, select `khejur-ghor-orders`, save, and redeploy. Bind it for both Production and Preview if both environments will be used.
4. In **Settings > Variables and Secrets**, add the following as encrypted secrets (not plain text variables), then redeploy:
   - `ADMIN_USERNAME`: choose an admin username.
   - `ADMIN_PASSWORD`: choose a unique password of at least 12 characters.
5. Test the `*.pages.dev` URL and `/admin`. The Pages URL can be used without a custom domain.

Pages Functions are limited to `/api/*` by `dist\_routes.json`; normal image and HTML requests remain static. The API validates orders, calculates prices on the server, and limits submissions to 20 per IP per 10 minutes. Customer names, phone numbers, and addresses are stored in D1. Restrict Cloudflare account access and do not share database exports. Check Cloudflare plan limits before running paid ads.

### Before advertising

Update the demo prices in both `index.html` and `server.ps1`, and replace the demo reviews with genuine customer feedback. The date photos' source and license information is in `wwwroot\images\ATTRIBUTION.txt`. A custom domain is optional; the Cloudflare `pages.dev` address works without one.
