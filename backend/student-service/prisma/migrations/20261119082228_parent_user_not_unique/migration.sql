-- DropIndex
DROP INDEX "parents_user_id_key";

-- CreateIndex
CREATE INDEX "parents_user_id_idx" ON "parents"("user_id");
