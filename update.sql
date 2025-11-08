ALTER TABLE model_payout_requests
ADD COLUMN wallet_transaction_id INT NULL DEFAULT NULL;  

ALTER TABLE payout_requests
ADD COLUMN wallet_transaction_id INT NULL DEFAULT NULL;