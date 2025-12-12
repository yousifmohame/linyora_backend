-- ALTER TABLE users ADD COLUMN stripe_customer_id VARCHAR(255) NULL AFTER email;

-- ALTER TABLE subscription_plans 
-- ADD COLUMN allows_promotion_in_stories BOOLEAN DEFAULT FALSE AFTER includes_dropshipping;

-- ALTER TABLE agreements
-- MODIFY COLUMN status ENUM(
--     'pending',
--     'accepted',
--     'rejected',
--     'in_progress',
--     'delivered',
--     'completed'
-- ) NOT NULL;


-- ALTER TABLE users 
-- ADD COLUMN is_super_admin BOOLEAN DEFAULT FALSE,
-- ADD COLUMN permissions JSON DEFAULT NULL;

-- -- اجعل حسابك الحالي هو السوبر أدمن (استبدل ID برقمك)
-- UPDATE users SET is_super_admin = TRUE WHERE id = 2;

-- 1. إضافة العمود لجدول طلبات سحب التجار
ALTER TABLE payout_requests
ADD COLUMN wallet_transaction_id INT NULL;

-- 2. إضافة العمود لجدول طلبات سحب المودلز (احتياطاً)
ALTER TABLE model_payout_requests
ADD COLUMN wallet_transaction_id INT NULL;

-- جدول العروض
CREATE TABLE flash_sales (
    id INT AUTO_INCREMENT PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    start_time DATETIME NOT NULL,
    end_time DATETIME NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- جدول المنتجات في العرض
CREATE TABLE flash_sale_products (
    id INT AUTO_INCREMENT PRIMARY KEY,
    flash_sale_id INT NOT NULL,
    product_id INT NOT NULL,
    discount_percentage DECIMAL(5,2) NOT NULL, -- نسبة الخصم لهذا المنتج في العرض
    sold_quantity INT DEFAULT 0, -- الكمية المباعة في العرض
    total_quantity INT NOT NULL, -- الكمية المخصصة للعرض
    FOREIGN KEY (flash_sale_id) REFERENCES flash_sales(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);