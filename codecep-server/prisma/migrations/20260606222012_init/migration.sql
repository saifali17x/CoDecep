-- CreateTable
CREATE TABLE "telemetry_packets" (
    "id" TEXT NOT NULL,
    "timestamp" BIGINT NOT NULL,
    "timeSinceLastKeystrokeMs" INTEGER NOT NULL,
    "actionType" TEXT NOT NULL,
    "charDelta" INTEGER NOT NULL,
    "textLength" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "telemetry_packets_pkey" PRIMARY KEY ("id")
);
