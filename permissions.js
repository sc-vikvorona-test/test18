class Role {
  constructor(name, permissions = []) {
    this.name = name;
    this.permissions = new Set(permissions);
    this.children = [];
  }

  addPermission(permission) {
    this.permissions.add(permission);
    return this;
  }

  removePermission(permission) {
    this.permissions.delete(permission);
    return this;
  }

  addChild(role) {
    this.children.push(role);
    return this;
  }

  getAllPermissions() {
    const all = new Set(this.permissions);
    for (const child of this.children) {
      for (const perm of child.getAllPermissions()) {
        all.add(perm);
      }
    }
    return all;
  }

  hasPermission(permission) {
    return this.getAllPermissions().has(permission);
  }
}

class RBAC {
  constructor() {
    this.roles = new Map();
    this.userRoles = new Map();
  }

  defineRole(name, permissions = [], parentRoles = []) {
    const role = new Role(name, permissions);
    for (const parentName of parentRoles) {
      const parent = this.roles.get(parentName);
      if (parent) role.addChild(parent);
    }
    this.roles.set(name, role);
    return role;
  }

  assignRole(userId, roleName) {
    if (!this.roles.has(roleName)) throw new Error(`Role not defined: ${roleName}`);
    const roles = this.userRoles.get(userId) || new Set();
    roles.add(roleName);
    this.userRoles.set(userId, roles);
  }

  revokeRole(userId, roleName) {
    const roles = this.userRoles.get(userId);
    if (roles) roles.delete(roleName);
  }

  hasPermission(userId, permission) {
    const userRoles = this.userRoles.get(userId) || new Set();
    for (const roleName of userRoles) {
      const role = this.roles.get(roleName);
      if (role && role.hasPermission(permission)) return true;
    }
    return false;
  }

  getUserPermissions(userId) {
    const all = new Set();
    const userRoles = this.userRoles.get(userId) || new Set();
    for (const roleName of userRoles) {
      const role = this.roles.get(roleName);
      if (role) for (const perm of role.getAllPermissions()) all.add(perm);
    }
    return all;
  }

  middleware(permission) {
    return (req, res, next) => {
      const userId = req.user && req.user.id;
      if (!userId || !this.hasPermission(userId, permission)) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      next();
    };
  }
}

module.exports = { Role, RBAC };


function requireAll(rbac, userId, permissions) {
  return permissions.every(p => rbac.hasPermission(userId, p));
}

function requireAny(rbac, userId, permissions) {
  return permissions.some(p => rbac.hasPermission(userId, p));
}

module.exports.requireAll = requireAll;
module.exports.requireAny = requireAny;
