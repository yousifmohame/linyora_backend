CREATE TABLE model_bank_details (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    bank_name VARCHAR(255) NULL,         -- ✨ (أضفنا هذا للموديل)
    account_holder_name VARCHAR(255) NULL, -- ✨ (أضفنا هذا للموديل)
    account_number VARCHAR(255) NULL,
    iban VARCHAR(255) NULL,
    iban_certificate_url VARCHAR(1024) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY (user_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);