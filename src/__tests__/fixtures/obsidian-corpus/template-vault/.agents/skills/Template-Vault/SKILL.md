```markdown
# Template-Vault Development Patterns

> Auto-generated skill from repository analysis

## Overview
This skill teaches you the core development patterns used in the Template-Vault repository, a TypeScript codebase with a focus on clear file organization, consistent import/export styles, and a straightforward approach to testing. You'll learn how to structure files, write and organize code, and follow the project's conventions to contribute effectively.

## Coding Conventions

### File Naming
- **Pattern:** PascalCase
- **Example:**  
  `UserProfile.ts`, `DataManager.ts`

### Import Style
- **Pattern:** Relative imports
- **Example:**
  ```typescript
  import { UserProfile } from './UserProfile';
  import { DataManager } from '../utils/DataManager';
  ```

### Export Style
- **Pattern:** Named exports
- **Example:**
  ```typescript
  // In UserProfile.ts
  export function UserProfile() { /* ... */ }

  // In DataManager.ts
  export const DataManager = { /* ... */ };
  ```

### Commit Messages
- **Pattern:** Freeform, no strict prefixes
- **Average Length:** ~50 characters
- **Example:**  
  `Add user profile component and update data manager`

## Workflows

### Adding a New Module
**Trigger:** When you need to introduce a new feature or component  
**Command:** `/add-module`

1. Create a new file using PascalCase (e.g., `NewFeature.ts`).
2. Use relative imports to include dependencies.
3. Export your functions or constants using named exports.
4. Write corresponding test files as `NewFeature.test.ts`.

### Updating an Existing Module
**Trigger:** When modifying or extending existing functionality  
**Command:** `/update-module`

1. Locate the relevant PascalCase file.
2. Make changes, maintaining relative imports and named exports.
3. Update or add tests in the corresponding `*.test.ts` file.
4. Commit changes with a concise, descriptive message.

### Writing Tests
**Trigger:** When adding or updating functionality  
**Command:** `/write-test`

1. Create or update a test file matching the pattern `ModuleName.test.ts`.
2. Write tests using the project's preferred (unknown) framework.
3. Ensure all new and existing tests pass before committing.

## Testing Patterns

- **Test File Pattern:** `*.test.*` (e.g., `UserProfile.test.ts`)
- **Framework:** Not specified; follow standard TypeScript testing practices.
- **Example:**
  ```typescript
  // UserProfile.test.ts
  import { UserProfile } from './UserProfile';

  describe('UserProfile', () => {
    it('should initialize correctly', () => {
      // test implementation
    });
  });
  ```

## Commands
| Command         | Purpose                                      |
|-----------------|----------------------------------------------|
| /add-module     | Scaffold a new module with proper conventions|
| /update-module  | Update an existing module                    |
| /write-test     | Create or update a test file                 |
```
