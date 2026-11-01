-- CreateTable
CREATE TABLE "Product" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "sourceKey" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "brand" TEXT,
    "category" TEXT NOT NULL,
    "vintage" TEXT,
    "region" TEXT,
    "country" TEXT,
    "bottleSize" TEXT,
    "packaging" TEXT,
    "clientPrice" REAL NOT NULL,
    "currency" TEXT,
    "metadata" JSONB,
    "sourceUpdatedAt" DATETIME,
    "importedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Vendor" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "website" TEXT,
    "states" TEXT,
    "sourceType" TEXT NOT NULL DEFAULT 'IMPORT',
    "integrationStatus" TEXT NOT NULL DEFAULT 'NONE',
    "lastSyncAt" DATETIME
);

-- CreateTable
CREATE TABLE "Offer" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "productId" INTEGER NOT NULL,
    "vendorId" INTEGER NOT NULL,
    "url" TEXT,
    "vendorProductId" TEXT,
    "price" REAL NOT NULL,
    "currency" TEXT,
    "bottleSize" TEXT,
    "vintageMatch" TEXT,
    "availability" TEXT,
    "stockStatus" TEXT,
    "shipping" REAL,
    "tax" REAL,
    "source" TEXT NOT NULL,
    "sourceReportedAt" DATETIME,
    "observedAt" DATETIME NOT NULL,
    "lastVerifiedAt" DATETIME,
    "verificationStatus" TEXT NOT NULL DEFAULT 'UNVERIFIED',
    "error" TEXT,
    "location" TEXT,
    "state" TEXT,
    "rating" REAL,
    CONSTRAINT "Offer_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Offer_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PriceHistory" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "offerId" INTEGER NOT NULL,
    "previousPrice" REAL,
    "price" REAL NOT NULL,
    "currency" TEXT,
    "observedAt" DATETIME NOT NULL,
    "source" TEXT NOT NULL,
    "refreshJobId" INTEGER,
    CONSTRAINT "PriceHistory_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "Offer" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PriceHistory_refreshJobId_fkey" FOREIGN KEY ("refreshJobId") REFERENCES "RefreshJob" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RefreshJob" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "provider" TEXT NOT NULL,
    "trigger" TEXT NOT NULL DEFAULT 'MANUAL',
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "processed" INTEGER NOT NULL DEFAULT 0,
    "succeeded" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "errorSummary" TEXT
);

-- CreateIndex
CREATE UNIQUE INDEX "Product_sourceKey_key" ON "Product"("sourceKey");

-- CreateIndex
CREATE UNIQUE INDEX "Product_sku_key" ON "Product"("sku");

-- CreateIndex
CREATE INDEX "Product_category_idx" ON "Product"("category");

-- CreateIndex
CREATE INDEX "Product_normalizedName_idx" ON "Product"("normalizedName");

-- CreateIndex
CREATE INDEX "Product_brand_idx" ON "Product"("brand");

-- CreateIndex
CREATE UNIQUE INDEX "Vendor_name_key" ON "Vendor"("name");

-- CreateIndex
CREATE INDEX "Offer_vendorId_idx" ON "Offer"("vendorId");

-- CreateIndex
CREATE INDEX "Offer_lastVerifiedAt_idx" ON "Offer"("lastVerifiedAt");

-- CreateIndex
CREATE INDEX "Offer_verificationStatus_idx" ON "Offer"("verificationStatus");

-- CreateIndex
CREATE UNIQUE INDEX "Offer_productId_vendorId_key" ON "Offer"("productId", "vendorId");

-- CreateIndex
CREATE INDEX "PriceHistory_offerId_observedAt_idx" ON "PriceHistory"("offerId", "observedAt");

-- CreateIndex
CREATE INDEX "RefreshJob_startedAt_idx" ON "RefreshJob"("startedAt");
