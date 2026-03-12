'use strict';
const jwt = require('jsonwebtoken');

module.exports = function auth(req, res, next) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer '))
    return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(h.slice(7), process.env.JWT_SECRET || 'bd-newsmap-change-this-in-production');
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
};
