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

-- 1. حذف الجدول القديم لضمان نظافة البيانات (إذا كان فيه بيانات تجريبية)
DROP TABLE IF EXISTS flash_sale_products;

-- 2. إعادة إنشاء الجدول مع الأعمدة الجديدة
CREATE TABLE flash_sale_products (
    id INT AUTO_INCREMENT PRIMARY KEY,
    flash_sale_id INT NOT NULL,
    product_id INT NOT NULL,
    variant_id INT NOT NULL, -- ✨ نربط الخصم بمتغير محدد
    merchant_id INT NOT NULL, -- ✨ لنعرف من هو التاجر المسؤول
    discount_percentage DECIMAL(5,2) NOT NULL,
    flash_price DECIMAL(10,2) NOT NULL, -- ✨ السعر بعد الخصم (للتسهيل)
    sold_quantity INT DEFAULT 0,
    total_quantity INT NOT NULL,
    status ENUM('pending', 'accepted', 'rejected') DEFAULT 'pending', -- ✨ حالة موافقة التاجر
    rejection_reason TEXT NULL,
    FOREIGN KEY (flash_sale_id) REFERENCES flash_sales(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
    FOREIGN KEY (variant_id) REFERENCES product_variants(id) ON DELETE CASCADE,
    FOREIGN KEY (merchant_id) REFERENCES users(id) ON DELETE CASCADE
);