-- جدول الأقسام الرئيسية
CREATE TABLE sections (
    id INT AUTO_INCREMENT PRIMARY KEY,
    title_en VARCHAR(255) NOT NULL,
    title_ar VARCHAR(255) NOT NULL,
    description_en TEXT,
    description_ar TEXT,
    featured_product_id INT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    sort_order INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (featured_product_id) REFERENCES products(id) ON DELETE SET NULL
);

-- جدول الشرائح (Slides) التابعة للقسم
CREATE TABLE section_slides (
    id INT AUTO_INCREMENT PRIMARY KEY,
    section_id INT NOT NULL,
    title_en VARCHAR(255),
    title_ar VARCHAR(255),
    description_en TEXT,
    description_ar TEXT,
    image_url VARCHAR(1024) NOT NULL,
    button_text_en VARCHAR(50),
    button_text_ar VARCHAR(50),
    button_link VARCHAR(1024),
    sort_order INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (section_id) REFERENCES sections(id) ON DELETE CASCADE
);

-- جدول الربط بين الأقسام والتصنيفات (Many-to-Many)
CREATE TABLE section_categories (
    section_id INT NOT NULL,
    category_id INT NOT NULL,
    PRIMARY KEY (section_id, category_id),
    FOREIGN KEY (section_id) REFERENCES sections(id) ON DELETE CASCADE,
    FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
);

ALTER TABLE sections 
ADD COLUMN icon VARCHAR(1024) NULL AFTER description_ar;

-- 1. إضافة لون للقسم
ALTER TABLE sections 
ADD COLUMN theme_color VARCHAR(20) DEFAULT '#ea580c' AFTER icon; 
-- القيمة الافتراضية هي لون البرتقالي الخاص بالموقع

-- 2. إضافة نوع الوسائط للشرائح
ALTER TABLE section_slides 
ADD COLUMN media_type ENUM('image', 'video') DEFAULT 'image' AFTER image_url;


-- 1. جدول أقسام القصص (الخاص بالأدمن فقط لإنشاء أقسام مثل "عروض"، "جديد"، إلخ)
CREATE TABLE IF NOT EXISTS story_sections (
    id INT AUTO_INCREMENT PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    cover_image VARCHAR(500), -- صورة الغلاف للقسم
    sort_order INT DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. جدول القصص الرئيسي
CREATE TABLE IF NOT EXISTS stories (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL, -- صاحب القصة (سواء أدمن أو تاجر أو مودل)
    section_id INT DEFAULT NULL, -- للأدمن فقط: لربط القصة بقسم معين
    type ENUM('image', 'video', 'text') NOT NULL DEFAULT 'image',
    media_url VARCHAR(500), -- رابط الصورة أو الفيديو
    text_content TEXT, -- النص (في حالة القصة النصية أو كشرح للصورة)
    background_color VARCHAR(50) DEFAULT '#000000', -- لون الخلفية للقصص النصية
    product_id INT DEFAULT NULL, -- لترويج منتج
    expires_at TIMESTAMP, -- موعد انتهاء القصة (عادة 24 ساعة)
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (section_id) REFERENCES story_sections(id) ON DELETE SET NULL,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL
);

-- 3. جدول مشاهدات القصص (اختياري للتحليلات)
CREATE TABLE IF NOT EXISTS story_views (
    id INT AUTO_INCREMENT PRIMARY KEY,
    story_id INT NOT NULL,
    viewer_id INT NOT NULL,
    viewed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (story_id) REFERENCES stories(id) ON DELETE CASCADE,
    FOREIGN KEY (viewer_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(story_id, viewer_id) -- المشاهدة تحسب مرة واحدة
);


