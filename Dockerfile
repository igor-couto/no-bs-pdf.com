# no-bs-pdf is a static site. We serve it with nginx.
# Base image is multi-arch, so it builds for linux/arm64 on the self-hosted runner.
FROM nginx:1.27-alpine

# Replace the stock server block with ours (caching, gzip, security headers, MIME).
RUN rm /etc/nginx/conf.d/default.conf
COPY deploy/nginx.conf /etc/nginx/conf.d/no-bs-pdf.conf

# Copy ONLY the web assets — never the source/CI/docs files.
COPY index.html styles.css app.js icon.svg og-image.svg site.webmanifest robots.txt sitemap.xml /usr/share/nginx/html/
COPY vendor/ /usr/share/nginx/html/vendor/

EXPOSE 80

# Container-level health check (the deploy job also probes HTTP from the host).
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null 2>&1 || exit 1
