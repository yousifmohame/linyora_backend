ALTER TABLE users ADD COLUMN stripe_customer_id VARCHAR(255) NULL AFTER email;

ALTER TABLE subscription_plans 
ADD COLUMN allows_promotion_in_stories BOOLEAN DEFAULT FALSE AFTER includes_dropshipping;

ALTER TABLE agreements
MODIFY COLUMN status ENUM(
    'pending',
    'accepted',
    'rejected',
    'in_progress',
    'delivered',
    'completed'
) NOT NULL;


ALTER TABLE users 
ADD COLUMN is_super_admin BOOLEAN DEFAULT FALSE,
ADD COLUMN permissions JSON DEFAULT NULL;

-- اجعل حسابك الحالي هو السوبر أدمن (استبدل ID برقمك)
UPDATE users SET is_super_admin = TRUE WHERE id = 2;