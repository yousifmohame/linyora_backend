const pool = require('../config/db');

// --- ✨ Get all service packages with their tiers for the current user ---
exports.getPackages = async (req, res) => {
    const userId = req.user.id;
    try {
        const [packages] = await pool.query(
            'SELECT * FROM service_packages WHERE user_id = ? ORDER BY created_at DESC',
            [userId]
        );

        if (packages.length === 0) {
            return res.json([]);
        }

        const packageIds = packages.map(p => p.id);
        const [tiers] = await pool.query(
            'SELECT * FROM package_tiers WHERE package_id IN (?) ORDER BY price ASC',
            [packageIds]
        );

        const packagesWithTiers = packages.map(pkg => ({
            ...pkg,
            tiers: tiers.filter(tier => tier.package_id === pkg.id)
        }));

        res.json(packagesWithTiers);
    } catch (error) {
        console.error("Failed to fetch service packages:", error);
        res.status(500).json({ message: "Error fetching service packages." });
    }
};


// --- ✨ Create a new service package with its tiers ---
exports.createPackage = async (req, res) => {
    const { title, description, category, status, tiers } = req.body;
    const userId = req.user.id;

    if (!title || !tiers || !Array.isArray(tiers) || tiers.length === 0) {
        return res.status(400).json({ message: 'Title and at least one tier are required.' });
    }

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        // 1. Insert the main package
        const [packageResult] = await connection.query(
            'INSERT INTO service_packages (user_id, title, description, category, status) VALUES (?, ?, ?, ?, ?)',
            [userId, title, description, category || 'General', status || 'active']
        );
        const packageId = packageResult.insertId;

        // 2. Insert all tiers for the package
        for (const tier of tiers) {
            const { tier_name, price, delivery_days, revisions, features } = tier;
            await connection.query(
                'INSERT INTO package_tiers (package_id, tier_name, price, delivery_days, revisions, features) VALUES (?, ?, ?, ?, ?, ?)',
                [packageId, tier_name, price, delivery_days, revisions, JSON.stringify(features || [])]
            );
        }

        await connection.commit();
        res.status(201).json({ message: 'Service package created successfully!', packageId });

    } catch (error) {
        await connection.rollback();
        console.error("Error creating service package:", error);
        res.status(500).json({ message: 'Failed to create service package.' });
    } finally {
        connection.release();
    }
};

// --- ✨ Update an existing service package and its tiers ---
exports.updatePackage = async (req, res) => {
    const { id } = req.params;
    const { title, description, category, status, tiers } = req.body;
    const userId = req.user.id;

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        
        // Verify ownership
        const [[pkg]] = await connection.query('SELECT id FROM service_packages WHERE id = ? AND user_id = ?', [id, userId]);
        if (!pkg) {
            await connection.rollback();
            return res.status(404).json({ message: 'Package not found or you do not have permission.' });
        }

        // 1. Update the main package
        await connection.query(
            'UPDATE service_packages SET title = ?, description = ?, category = ?, status = ? WHERE id = ?',
            [title, description, category, status, id]
        );

        // 2. Delete old tiers
        await connection.query('DELETE FROM package_tiers WHERE package_id = ?', [id]);

        // 3. Insert new tiers
        for (const tier of tiers) {
            const { tier_name, price, delivery_days, revisions, features } = tier;
            await connection.query(
                'INSERT INTO package_tiers (package_id, tier_name, price, delivery_days, revisions, features) VALUES (?, ?, ?, ?, ?, ?)',
                [id, tier_name, price, delivery_days, revisions, JSON.stringify(features || [])]
            );
        }

        await connection.commit();
        res.status(200).json({ message: 'Service package updated successfully!' });

    } catch (error) {
        await connection.rollback();
        console.error("Error updating service package:", error);
        res.status(500).json({ message: 'Failed to update service package.' });
    } finally {
        connection.release();
    }
};


// --- ✨ Delete a service package ---
exports.deletePackage = async (req, res) => {
    const { id } = req.params;
    const userId = req.user.id;
    try {
        const [result] = await pool.query('DELETE FROM service_packages WHERE id = ? AND user_id = ?', [id, userId]);
        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Package not found or you do not have permission.' });
        }
        res.status(200).json({ message: 'Service package deleted successfully.' });
    } catch (error) {
        console.error("Error deleting service package:", error);
        res.status(500).json({ message: 'Failed to delete service package.' });
    }
};
