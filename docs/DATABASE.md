# DATABASE (Prisma, SQLite)
- **Product**: id, sourceKey (unique, natural key from JSON id), name, normalizedName, brand?, category, vintage?, region?, country?, bottleSize?, packaging?, clientPrice, currency?, sku (stable, assigned at import), metadata(json), importedAt.
- **Vendor**: id, name (unique), website?, states?, sourceType, integrationStatus, lastSyncAt?.
- **Offer**: id, productId, vendorId (unique pair), url?, vendorProductId?, price, currency?, bottleSize?, vintageMatch?, availability?, stockStatus?, shipping?, tax?, source, sourceReportedAt?, observedAt, lastVerifiedAt?, verificationStatus (DEMO|UNVERIFIED|VERIFIED|STALE|FAILED), error?, location?, rating?.
- **PriceHistory**: id, offerId, previousPrice?, price, currency?, observedAt, source, refreshJobId?.
- **RefreshJob**: id, provider, startedAt, finishedAt?, status (RUNNING|SUCCESS|PARTIAL|FAILED|SKIPPED), processed, succeeded, failed, errorSummary?.
Indexes: Product(category), Product(normalizedName), Offer(vendorId), Offer(lastVerifiedAt), PriceHistory(offerId, observedAt). No secrets stored.
