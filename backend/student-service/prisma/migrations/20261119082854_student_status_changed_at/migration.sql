-- AlterTable
ALTER TABLE "students" ADD COLUMN     "status_changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE INDEX "students_status_status_changed_at_idx" ON "students"("status", "status_changed_at");
