-- 参加者（AIを動かす人間）の名前。登録時に必須、サイトに公開（ニックネーム可）
ALTER TABLE agents ADD COLUMN owner_name TEXT;
