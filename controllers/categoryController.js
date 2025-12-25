// backend/controllers/categoryController.js
const asyncHandler = require("express-async-handler");
const pool = require("../config/db");

// --- ✨ دالة جديدة ومحسّنة: لتوليد slug فريد يدعم العربية ---
const generateUniqueSlug = async (name) => {
  if (!name || typeof name !== "string") {
    // في حالة عدم وجود اسم، قم بإنشاء slug عشوائي لتجنب الأخطاء
    return `category-${Date.now()}`;
  }

  // 1. تحويل الاسم إلى صيغة مناسبة للرابط مع دعم العربية
  let slug = name
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-") // استبدال المسافات بـ -
    .replace(/&/g, "-and-") // استبدال & بـ 'and'
    .replace(/[^\u0600-\u06FF\w\s-]/g, "") // إزالة الرموز الخاصة مع الإبقاء على العربية والإنجليزية والأرقام والشرطات
    .replace(/\-\-+/g, "-"); // استبدال الـ -- المتعددة بـ - واحدة

  // إذا كان الناتج فارغًا (مثلاً، الاسم كان مجرد رموز)، قم بإنشاء slug عشوائي
  if (!slug) {
    slug = `category-${Date.now()}`;
  }

  // 2. التحقق من أن الـ slug فريد في قاعدة البيانات
  let isUnique = false;
  let counter = 1;
  const originalSlug = slug;

  while (!isUnique) {
    const [existing] = await pool.query(
      "SELECT id FROM categories WHERE slug = ?",
      [slug]
    );
    if (existing.length === 0) {
      isUnique = true; // الـ slug فريد
    } else {
      // إذا كان الـ slug موجودًا، أضف رقمًا في نهايته وحاول مرة أخرى
      slug = `${originalSlug}-${counter}`;
      counter++;
    }
  }
  return slug;
};

// دالة مساعدة لبناء هيكل الشجرة
const buildCategoryTree = (categories, parentId = null) => {
  const tree = [];
  categories
    .filter((category) => category.parent_id === parentId)
    .forEach((category) => {
      const children = buildCategoryTree(categories, category.id);
      if (children.length) {
        category.children = children;
      }
      tree.push(category);
    });
  return tree;
};

// @desc    Get all categories as a tree
// @route   GET /api/categories
// @access  Public
exports.getAllCategories = asyncHandler(async (req, res) => {
  // تم تعديل الاستعلام ليستخدم جدول الربط product_categories
  const [categories] = await pool.query(`
        SELECT 
            c.*, 
            COUNT(pc.product_id) as product_count
        FROM 
            categories c
        LEFT JOIN 
            product_categories pc ON c.id = pc.category_id
        GROUP BY 
            c.id
        ORDER BY 
            c.sort_order ASC, c.name ASC
    `);

  const categoryTree = buildCategoryTree(categories);
  res.json(categoryTree);
});

// @desc    Create a new category with image upload
// @route   POST /api/categories
// @access  Admin
exports.createCategory = asyncHandler(async (req, res) => {
  const { name, parent_id, description, is_active, sort_order } = req.body;

  // التأكد من أن حقل الاسم موجود
  if (!name || name.trim() === "") {
    res.status(400);
    throw new Error("Category name is required.");
  }

  // 1. توليد slug فريد تلقائيًا من الاسم
  const slug = await generateUniqueSlug(name);

  // 2. التعامل مع الصورة المرفوعة (إن وجدت)
  const image_url = req.file ? req.file.path : null;

  // 3. إضافة الفئة إلى قاعدة البيانات مع الـ slug الجديد
  const [result] = await pool.query(
    "INSERT INTO categories (name, slug, parent_id, description, is_active, sort_order, image_url) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [
      name,
      slug,
      parent_id === "null" ? null : parent_id,
      description,
      is_active === "true",
      sort_order,
      image_url,
    ]
  );
  res.status(201).json({ id: result.insertId, name, slug, ...req.body });
});

// @desc    Update a category with optional image upload
// @route   PUT /api/categories/:id
// @access  Admin
exports.updateCategory = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const {
    name,
    parent_id,
    description,
    is_active,
    sort_order,
    image_url: existing_image_url,
  } = req.body;

  let image_url = existing_image_url;
  // إذا تم رفع ملف جديد، استخدم الرابط الجديد
  if (req.file) {
    image_url = req.file.path;
  }

  await pool.query(
    "UPDATE categories SET name = ?, parent_id = ?, description = ?, is_active = ?, sort_order = ?, image_url = ? WHERE id = ?",
    [
      name,
      parent_id === "null" ? null : parent_id,
      description,
      is_active === "true",
      sort_order,
      image_url,
      id,
    ]
  );
  res.json({
    message: "Category updated successfully",
    ...req.body,
    image_url,
  });
});

// @desc    Delete a category
// @route   DELETE /api/categories/:id
// @access  Admin
exports.deleteCategory = asyncHandler(async (req, res) => {
  const { id } = req.params;
  // (منطق اختياري) تحقق إذا كانت الفئة تحتوي على فئات فرعية قبل الحذف
  const [children] = await pool.query(
    "SELECT id FROM categories WHERE parent_id = ?",
    [id]
  );
  if (children.length > 0) {
    return res
      .status(400)
      .json({ message: "Cannot delete category with sub-categories." });
  }
  await pool.query("DELETE FROM categories WHERE id = ?", [id]);
  res.json({ message: "Category deleted successfully" });
});

const getAllDescendantIds = (allCategories, parentId) => {
  let ids = [parentId];
  const children = allCategories.filter((c) => c.parent_id === parentId);

  for (const child of children) {
    ids = [...ids, ...getAllDescendantIds(allCategories, child.id)];
  }
  return ids;
};

/**
 * @desc    Get category details and products by category slug (Main + Subcategories)
 * @route   GET /api/browse/categories/:slug
 * @access  Public
 */
exports.getProductsByCategorySlug = asyncHandler(async (req, res) => {
  const { slug } = req.params;

  // 1. جلب بيانات الفئة الأساسية
  const [[category]] = await pool.query(
    "SELECT id, name FROM categories WHERE slug = ?",
    [slug]
  );

  if (!category) {
    return res.status(404).json({ message: "Category not found" });
  }

  // 2. جلب التصنيفات الفرعية المباشرة (للعرض في السلايدر العلوي)
  const [subcategories] = await pool.query(
    "SELECT id, name, slug, image_url FROM categories WHERE parent_id = ?",
    [category.id]
  );

  // 3. ✨ الخطوة الجديدة: تحديد كل الأقسام التابعة (الأبناء والأحفاد)
  // نجلب فقط المعرفات والعلاقات لتخفيف الحمل
  const [allCategories] = await pool.query("SELECT id, parent_id FROM categories");
  
  // نستخدم الدالة المساعدة لجمع كل الـ IDs
  const targetCategoryIds = getAllDescendantIds(allCategories, category.id);

  // 4. جلب المنتجات (تم التعديل لاستخدام IN بدلاً من =)
  const [products] = await pool.query(
    `
        SELECT 
            p.id, 
            p.name, 
            p.description, 
            p.brand, 
            p.status, 
            p.merchant_id, 
            u.store_name as merchantName,
            p.price, -- تأكد من وجود السعر
            p.image_url as image,
            (SELECT AVG(rating) FROM product_reviews WHERE product_id = p.id) as rating,
            (SELECT COUNT(*) FROM product_reviews WHERE product_id = p.id) as reviewCount,

            -- بيانات المورد والدروبشيبينغ
            MAX(sp.supplier_id) as supplier_id,
            MAX(sup_u.name) as supplier_name,
            (MAX(sp.supplier_id) IS NOT NULL) as is_dropshipping

        FROM products p
        JOIN users u ON p.merchant_id = u.id
        JOIN product_categories pc ON p.id = pc.product_id
        
        -- الربط مع جداول الدروبشيبينغ
        LEFT JOIN product_variants pv ON p.id = pv.product_id
        LEFT JOIN dropship_links dl ON pv.id = dl.merchant_variant_id
        LEFT JOIN supplier_product_variants spv ON dl.supplier_variant_id = spv.id
        LEFT JOIN supplier_products sp ON spv.product_id = sp.id
        LEFT JOIN users sup_u ON sp.supplier_id = sup_u.id

        -- ✨ التغيير الجوهري هنا: البحث في القائمة الكاملة للأقسام
        WHERE p.status = 'active' AND pc.category_id IN (?)
        
        GROUP BY p.id
        ORDER BY p.created_at DESC
    `,
    [targetCategoryIds] // نمرر مصفوفة الـ IDs كاملة
  );

  // إذا لم توجد منتجات، نعيد مصفوفة فارغة ولكن مع بيانات القسم
  if (products.length === 0) {
    return res.status(200).json({
      products: [],
      categoryName: category.name,
      subcategories: subcategories || [],
    });
  }

  // 5. جلب المتغيرات (Variants) للمنتجات التي وجدناها
  const productIds = products.map((p) => p.id);
  let variants = [];

  if (productIds.length > 0) {
    const [rows] = await pool.query(
      "SELECT * FROM product_variants WHERE product_id IN (?) AND stock_quantity > 0",
      [productIds]
    );
    variants = rows;
  }

  // تنظيم المتغيرات في Map لسهولة الوصول
  const variantsMap = new Map();
  variants.forEach((variant) => {
    try {
      variant.images =
        typeof variant.images === "string"
          ? JSON.parse(variant.images)
          : variant.images;
    } catch (e) {
      variant.images = [];
    }

    const items = variantsMap.get(variant.product_id) || [];
    items.push(variant);
    variantsMap.set(variant.product_id, items);
  });

  // 6. دمج البيانات وتنسيق الاستجابة
  const productsWithData = products
    .map((product) => {
      const productVariants = variantsMap.get(product.id) || [];

      // منطق اختياري: استخدام صورة المتغير الأول إذا لم تكن صورة المنتج موجودة
      /*
      if (!product.image && productVariants.length > 0 && productVariants[0].images?.length > 0) {
          product.image = productVariants[0].images[0];
      }
      */

      return {
        ...product,
        is_dropshipping: !!product.is_dropshipping,
        variants: productVariants,
        rating: parseFloat(product.rating) || 0,
        reviewCount: parseInt(product.reviewCount, 10) || 0,
      };
    })
    .filter((p) => p.variants.length > 0); // (اختياري) إخفاء المنتجات التي نفذت كمياتها

  res.status(200).json({
    products: productsWithData,
    categoryName: category.name,
    subcategories: subcategories || [],
  });
});