const pool = require("../config/db");

// --- (Public) للعملاء ---
const getActiveSections = async (req, res) => {
  try {
    const [sections] = await pool.query(`
      SELECT s.*, 
             -- جلب اللون والايقونة وكل البيانات الجديدة تلقائياً عبر s.*
             p.name as product_name_en, 
             p.name as product_name_ar, 
             (SELECT price FROM product_variants WHERE product_id = p.id LIMIT 1) as product_price,
             (SELECT JSON_UNQUOTE(JSON_EXTRACT(images, '$[0]')) FROM product_variants WHERE product_id = p.id LIMIT 1) as product_image
      FROM sections s
      LEFT JOIN products p ON s.featured_product_id = p.id
      WHERE s.is_active = TRUE
      ORDER BY s.sort_order ASC
    `);

    const sectionsWithData = await Promise.all(
      sections.map(async (section) => {
        const [slides] = await pool.query(
          "SELECT * FROM section_slides WHERE section_id = ? ORDER BY sort_order ASC",
          [section.id]
        );

        const [categories] = await pool.query(
          `
        SELECT c.* FROM categories c
        JOIN section_categories sc ON c.id = sc.category_id
        WHERE sc.section_id = ?
      `,
          [section.id]
        );

        return { ...section, slides, categories };
      })
    );

    res.json(sectionsWithData);
  } catch (error) {
    console.error("Error in getActiveSections:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

const getSectionById = async (req, res) => {
  try {
    const { id } = req.params;
    const [sections] = await pool.query(
      `SELECT * FROM sections WHERE id = ? AND is_active = TRUE`,
      [id]
    );

    if (sections.length === 0)
      return res.status(404).json({ message: "Section not found" });

    const section = sections[0];
    const [slides] = await pool.query(
      "SELECT * FROM section_slides WHERE section_id = ? ORDER BY sort_order ASC",
      [id]
    );
    const [categories] = await pool.query(
      `
      SELECT c.* FROM categories c
      JOIN section_categories sc ON c.id = sc.category_id
      WHERE sc.section_id = ?
    `,
      [id]
    );

    res.json({
      ...section,
      slides,
      categories,
      category_ids: categories.map((c) => c.id),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
};

// --- (Private) للأدمن ---
const getAllSectionsAdmin = async (req, res) => {
  try {
    const [sections] = await pool.query(`
            SELECT s.*,
                   (SELECT name FROM products WHERE id = s.featured_product_id) as product_name_en
            FROM sections s 
            ORDER BY s.created_at DESC
        `);

    const fullSections = await Promise.all(
      sections.map(async (section) => {
        const [slides] = await pool.query(
          "SELECT * FROM section_slides WHERE section_id = ?",
          [section.id]
        );
        const [categories] = await pool.query(
          "SELECT category_id FROM section_categories WHERE section_id = ?",
          [section.id]
        );
        return {
          ...section,
          slides,
          categories,
          category_ids: categories.map((c) => c.category_id),
        };
      })
    );

    res.json(fullSections);
  } catch (error) {
    res.status(500).json({ message: "Error fetching sections" });
  }
};

const createSection = async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const {
      title_en,
      title_ar,
      description_en,
      description_ar,
      icon,
      theme_color, // <-- الحقل الجديد
      featured_product_id,
      is_active,
      slides,
      category_ids,
    } = req.body;

    let validProductId = null;
    if (featured_product_id && featured_product_id !== "no_product") {
      const productId = parseInt(featured_product_id);
      if (!isNaN(productId)) {
        const [productCheck] = await connection.query(
          "SELECT id FROM products WHERE id = ?",
          [productId]
        );
        if (productCheck.length > 0) validProductId = productId;
      }
    }

    const [result] = await connection.query(
      `
      INSERT INTO sections (title_en, title_ar, description_en, description_ar, icon, theme_color, featured_product_id, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
      [
        title_en,
        title_ar,
        description_en,
        description_ar,
        icon || null,
        theme_color || "#ea580c",
        validProductId,
        is_active ? 1 : 0,
      ]
    );

    const sectionId = result.insertId;

    if (slides && slides.length > 0) {
      const slideValues = slides.map((slide) => [
        sectionId,
        slide.title_en,
        slide.title_ar,
        slide.description_en,
        slide.description_ar,
        slide.image_url,
        slide.media_type || "image", // <-- الحقل الجديد
        slide.button_text_en,
        slide.button_text_ar,
        slide.button_link,
      ]);
      await connection.query(
        `
        INSERT INTO section_slides (section_id, title_en, title_ar, description_en, description_ar, image_url, media_type, button_text_en, button_text_ar, button_link)
        VALUES ?
      `,
        [slideValues]
      );
    }

    if (category_ids && category_ids.length > 0) {
      const categoryValues = category_ids.map((catId) => [sectionId, catId]);
      await connection.query(
        "INSERT INTO section_categories (section_id, category_id) VALUES ?",
        [categoryValues]
      );
    }

    await connection.commit();
    res
      .status(201)
      .json({ message: "Section created successfully", sectionId });
  } catch (error) {
    await connection.rollback();
    console.error("Create Section Error:", error);
    res.status(500).json({ message: "Failed to create section" });
  } finally {
    connection.release();
  }
};

const updateSection = async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { id } = req.params;
    const {
      title_en,
      title_ar,
      description_en,
      description_ar,
      icon,
      theme_color, // <-- الحقل الجديد
      featured_product_id,
      is_active,
      slides,
      category_ids,
    } = req.body;

    let validProductId = null;
    if (featured_product_id && featured_product_id !== "no_product") {
      const productId = parseInt(featured_product_id);
      if (!isNaN(productId)) validProductId = productId;
    }

    await connection.query(
      `
        UPDATE sections 
        SET title_en=?, title_ar=?, description_en=?, description_ar=?, icon=?, theme_color=?, featured_product_id=?, is_active=?
        WHERE id=?
      `,
      [
        title_en,
        title_ar,
        description_en,
        description_ar,
        icon || null,
        theme_color || "#ea580c",
        validProductId,
        is_active ? 1 : 0,
        id,
      ]
    );

    await connection.query("DELETE FROM section_slides WHERE section_id = ?", [
      id,
    ]);
    if (slides && slides.length > 0) {
      const slideValues = slides.map((slide) => [
        id,
        slide.title_en,
        slide.title_ar,
        slide.description_en,
        slide.description_ar,
        slide.image_url,
        slide.media_type || "image", // <-- الحقل الجديد
        slide.button_text_en,
        slide.button_text_ar,
        slide.button_link,
      ]);
      await connection.query(
        `
          INSERT INTO section_slides (section_id, title_en, title_ar, description_en, description_ar, image_url, media_type, button_text_en, button_text_ar, button_link)
          VALUES ?
        `,
        [slideValues]
      );
    }

    await connection.query(
      "DELETE FROM section_categories WHERE section_id = ?",
      [id]
    );
    if (category_ids && category_ids.length > 0) {
      const categoryValues = category_ids.map((catId) => [id, catId]);
      await connection.query(
        "INSERT INTO section_categories (section_id, category_id) VALUES ?",
        [categoryValues]
      );
    }

    await connection.commit();
    res.json({ message: "Section updated successfully" });
  } catch (error) {
    await connection.rollback();
    console.error(error);
    res.status(500).json({ message: "Failed to update section" });
  } finally {
    connection.release();
  }
};

const deleteSection = async (req, res) => {
  try {
    await pool.query("DELETE FROM sections WHERE id = ?", [req.params.id]);
    res.json({ message: "Section deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: "Failed to delete section" });
  }
};

module.exports = {
  getActiveSections,
  getSectionById,
  getAllSectionsAdmin,
  createSection,
  updateSection,
  deleteSection,
};
