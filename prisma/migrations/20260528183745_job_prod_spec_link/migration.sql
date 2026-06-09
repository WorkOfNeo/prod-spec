-- AlterTable
ALTER TABLE "jobs" ADD COLUMN     "prodSpecId" TEXT;

-- CreateIndex
CREATE INDEX "jobs_prodSpecId_idx" ON "jobs"("prodSpecId");

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_prodSpecId_fkey" FOREIGN KEY ("prodSpecId") REFERENCES "prod_specs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
