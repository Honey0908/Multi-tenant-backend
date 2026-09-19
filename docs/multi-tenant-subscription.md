# POC: Multi-Tenant Task Management System

**Track:** Platform\
**Status:** Required\
**Path:** React to Full Stack --- 101\
**Duration:** 2-week solo POC\
**Project Type:** Multi-tenant Jira/Zoho-style Task Management Platform

---

## 1. Project Overview

The POC will implement a simplified **Jira/Zoho-style task management
platform** for multiple client organisations.

Each organisation will have its own users, projects, tasks, comments,
and related data. The most important architectural requirement is that
**tenant isolation is structural**, rather than relying on developers
remembering to add `tenant_id` filters to every database query.

The system will demonstrate:

- Multi-tenant organisation isolation
- Authentication and role-based authorization
- Self-service organisation onboarding
- Organisation/user management
- Projects and tasks
- Task assignment and status management
- Plan-based limits
- Concurrency-safe plan enforcement
- Platform-admin visibility without tenant-content access
- Validation at API boundaries
- Audit/security logging
- Docker-based local setup
- Automated tests for the critical security boundaries

The goal is not to build a full Jira clone. The goal is to use a
realistic task-management domain to demonstrate **secure multi-tenant
architecture and backend engineering practices**.

---

# 2. Technology Stack

## Frontend

- React 19
- TypeScript
- Vite
- React Router
- TanStack Query
- React Hook Form
- Zod
- Axios
- Tailwind CSS
- shadcn/ui or equivalent component library

## Backend

- Node.js
- Express
- TypeScript
- Zod
- Prisma ORM
- PostgreSQL
- JWT authentication
- Argon2 password hashing

## Infrastructure / Development

- Docker
- Docker Compose
- pnpm
- ESLint
- Prettier
- Vitest
- Supertest
- Prisma migrations
- Environment-based configuration

---

# 3. Actors and Permissions

## 3.1 Platform Admin

Platform-level user.

Can:

- View all organisations
- View organisation metadata
- View assigned plan
- View aggregate usage
- View organisation status
- View platform-level audit/security information

Cannot:

- View organisation projects
- View tasks
- View comments
- View organisation users' task content
- Access tenant business data

The platform admin should have visibility into **metadata and usage**,
not tenant content.

---

## 3.2 Organisation Admin

Administrator inside one organisation.

Can:

- View their organisation
- Manage organisation users
- Invite users
- Remove users
- Assign organisation roles
- Create projects
- Manage projects
- Create/update/delete tasks
- Assign tasks to organisation users
- View organisation usage
- View plan limits
- Manage task/project data belonging to their organisation

Cannot:

- Access another organisation
- Modify another organisation's users
- Access another organisation's projects/tasks
- Change platform-level configuration

---

## 3.3 Organisation Member

Regular user inside one organisation.

Can:

- View their organisation's projects
- View tasks
- Create tasks if permitted
- Update tasks they are allowed to modify
- Comment on tasks
- Update task status
- View their own profile

Cannot:

- Manage organisation users
- Change organisation plan
- Access another organisation's data
- Access platform-admin functionality

---

# 4. Core Domain Model

The application will use a task-management domain.

High-level relationship:

```text
Platform
   |
   +-- Organisations
          |
          +-- Plan
          |
          +-- Users
          |
          +-- Projects
                 |
                 +-- Tasks
                        |
                        +-- Comments
                        |
                        +-- Assignees
```

---

# 5. Database Schema

The exact Prisma schema can evolve, but the following entities are
expected.

## 5.1 Organisation

```text
Organisation
- id
- name
- slug
- status
- planId
- createdAt
- updatedAt
```

Every tenant-owned entity must be traceable to an organisation.

---

## 5.2 User

```text
User
- id
- organisationId
- email
- passwordHash
- firstName
- lastName
- role
- status
- createdAt
- updatedAt
```

A user belongs to exactly one organisation.

Example roles:

```text
ORG_ADMIN
ORG_MEMBER
PLATFORM_ADMIN
```

A platform admin may not need an `organisationId`, depending on the
authentication model.

---

## 5.3 Plan

```text
Plan
- id
- name
- maxUsers
- maxProjects
- maxTasks
- maxStorage
- createdAt
- updatedAt
```

Example:

Plan Users Projects Tasks

---

Starter 5 3 100
Professional 25 20 1,000
Enterprise 100 100 10,000

The exact values are configurable.

---

## 5.4 Project

```text
Project
- id
- organisationId
- name
- key
- description
- status
- createdById
- createdAt
- updatedAt
```

Example:

```text
Organisation: Acme
Project: Website Redesign
Key: WEB
```

---

## 5.5 Task

```text
Task
- id
- organisationId
- projectId
- title
- description
- status
- priority
- assigneeId
- reporterId
- dueDate
- createdAt
- updatedAt
```

Example statuses:

```text
TODO
IN_PROGRESS
IN_REVIEW
DONE
```

Example priorities:

```text
LOW
MEDIUM
HIGH
URGENT
```

---

## 5.6 Comment

```text
Comment
- id
- organisationId
- taskId
- authorId
- content
- createdAt
- updatedAt
```

Comments must always remain within the task's organisation.

---

## 5.7 Invitation

```text
Invitation
- id
- organisationId
- email
- role
- token
- expiresAt
- status
- invitedById
- createdAt
```

Possible statuses:

```text
PENDING
ACCEPTED
EXPIRED
REVOKED
```

---

## 5.8 Audit Log

```text
AuditLog
- id
- organisationId
- actorUserId
- action
- resourceType
- resourceId
- metadata
- createdAt
```

Examples:

```text
USER_INVITED
USER_REMOVED
PROJECT_CREATED
TASK_CREATED
TASK_UPDATED
CROSS_TENANT_ACCESS_ATTEMPT
PLAN_LIMIT_REACHED
ORGANISATION_CREATED
```

For platform-level events, `organisationId` can be nullable.

---

# 6. Multi-Tenant Isolation Strategy

This is the most important architectural decision in the POC.

## Recommended approach

Use a **request-scoped tenant context + tenant-aware data-access
layer**.

The request lifecycle should look like:

```text
HTTP Request
     |
     v
Authentication Middleware
     |
     v
Resolve User
     |
     v
Resolve Organisation / Tenant Context
     |
     v
Authorization Middleware
     |
     v
Tenant-aware Service / Repository
     |
     v
Prisma
     |
     v
PostgreSQL
```

The authenticated user determines the tenant context.

The client should **not** be trusted to provide the organisation ID.

For example, avoid:

```http
GET /api/tasks?organisationId=org-123
```

Instead:

```http
GET /api/tasks
Authorization: Bearer <token>
```

The backend determines:

```text
user -> organisationId
```

---

# 7. Tenant-Aware Data Access

All tenant-owned queries should go through a tenant-aware
repository/data-access mechanism.

For example:

```text
taskRepository.findById(taskId)
```

should internally ensure:

```text
task.id = taskId
AND
task.organisationId = currentTenantId
```

rather than requiring every service to manually write:

```text
WHERE id = taskId
AND organisationId = tenantId
```

This reduces the chance of future developers accidentally introducing a
cross-tenant data leak.

---

# 8. The Critical Security Test

Create two organisations:

```text
Organisation A
- User A
- Project A
- Task A

Organisation B
- User B
- Project B
- Task B
```

Authenticate as User A.

Attempt:

```http
GET /api/tasks/<task-B-id>
```

Expected:

```http
404 Not Found
```

or another intentionally chosen non-disclosing response.

The response must not expose:

- Task title
- Task description
- Project information
- Assignee
- Organisation information
- Any other tenant data

The test should explicitly prove:

```text
User A -> Task B = DENIED
User B -> Task B = ALLOWED
```

---

# 9. Careless Query Test

A key walkthrough requirement is demonstrating what happens when a
developer forgets tenant scoping.

Add a deliberately careless query such as:

```text
findTaskById(taskId)
```

without manually passing `organisationId`.

The architecture should either:

1.  Automatically apply tenant context, or
2.  Prevent the query from being used from tenant-scoped application
    code.

The important point is:

> Tenant isolation should be difficult to bypass accidentally.

The test should demonstrate that a newly added feature cannot silently
expose another organisation's data.

---

# 10. Authentication

There should be no anonymous access to application APIs.

Authentication flow:

```text
Signup
   |
   v
Organisation + Admin User
   |
   v
Login
   |
   v
JWT Access Token
   |
   v
Authenticated API Requests
```

JWT payload can contain minimal identity information:

```json
{
  "sub": "user-id",
  "role": "ORG_ADMIN",
  "organisationId": "organisation-id"
}
```

The backend should still validate the user's current database state
instead of blindly trusting authorization data forever.

---

# 11. Password Security

Passwords must never be stored directly.

Use:

```text
Argon2
```

for password hashing.

Example:

```text
Plain password
      |
      v
Argon2
      |
      v
Password hash
      |
      v
PostgreSQL
```

---

# 12. Self-Service Organisation Onboarding

Signup should create:

```text
Organisation
    +
First Admin User
    +
Default Plan Assignment
```

Example:

```http
POST /api/auth/signup
```

Request:

```json
{
  "organisationName": "Acme Inc",
  "adminName": "John Doe",
  "email": "john@acme.com",
  "password": "..."
}
```

Response:

```json
{
  "organisation": {
    "id": "...",
    "name": "Acme Inc"
  },
  "user": {
    "id": "...",
    "email": "john@acme.com",
    "role": "ORG_ADMIN"
  }
}
```

---

# 13. Onboarding Transaction

Organisation creation and initial user creation must happen inside one
database transaction.

Conceptually:

```text
BEGIN TRANSACTION

Create Organisation
Create Plan Assignment
Create Admin User
Create Default Records

COMMIT
```

If any operation fails:

```text
ROLLBACK
```

This prevents:

```text
Organisation exists
BUT
Admin user does not exist
```

The signup request can then be retried safely.

---

# 14. Plans and Limits

Plans should enforce actual limits.

Example:

```text
Starter
maxUsers = 5
maxProjects = 3
maxTasks = 100
```

If the organisation already has 5 users:

```text
Invite User
     |
     v
Check limit
     |
     v
Limit reached
     |
     v
Reject
```

Response:

```json
{
  "code": "PLAN_USER_LIMIT_REACHED",
  "message": "Your Starter plan allows a maximum of 5 users."
}
```

Avoid generic responses such as:

```text
Something went wrong.
```

---

# 15. Concurrency-Safe Limit Enforcement

This is another important backend requirement.

The following situation must not happen:

```text
Plan limit = 5

Current users = 4

Request A -> sees 4 -> allows user
Request B -> sees 4 -> allows user

Result = 6 users
```

The implementation must guarantee:

```text
Current users = 4
Limit = 5

Request A -> SUCCESS
Request B -> REJECTED
```

Possible implementation:

- PostgreSQL transaction
- Appropriate row locking
- Serializable transaction where appropriate
- Atomic counter update
- Database constraint where applicable

The chosen approach should be documented in the architecture notes.

---

# 16. Concurrency Test

Create an organisation:

```text
Plan limit = 5 users
Current users = 4
```

Fire two invite requests simultaneously:

```text
Request A
Request B
```

Expected:

```text
Request A -> 201 Created
Request B -> 409 Conflict
```

Final user count:

```text
5
```

Never:

```text
6
```

The test must run against PostgreSQL, not only mocked repositories.

---

# 17. Project Management Features

The application should provide a simplified project-management workflow.

## Project creation

Organisation admin can create:

```text
Project
- Name
- Key
- Description
```

Example:

```text
Project: Website Redesign
Key: WEB
```

---

## Project list

Users should only see projects belonging to their organisation.

```http
GET /api/projects
```

The backend applies tenant scope automatically.

---

# 18. Task Management

Users can:

- Create tasks
- View tasks
- Update tasks
- Assign tasks
- Change status
- Change priority
- Add comments

Example:

```http
POST /api/projects/:projectId/tasks
```

Request:

```json
{
  "title": "Implement login page",
  "description": "Create responsive login UI",
  "priority": "HIGH",
  "assigneeId": "user-id"
}
```

---

# 19. Task Detail

Example:

```http
GET /api/tasks/:taskId
```

The task must be returned only when:

```text
task.organisationId
==
authenticatedUser.organisationId
```

A valid task ID from another organisation must not bypass this rule.

---

# 20. Task Assignment Security

When assigning a task:

```text
Task -> Organisation A
Assignee -> Organisation B
```

must be rejected.

The backend should validate:

```text
task.organisationId == assignee.organisationId
```

This demonstrates that tenant isolation applies not only to reads but
also to relationships and writes.

---

# 21. Organisation User Management

Org admins can:

- List users
- Invite users
- Remove users
- Change roles

Example APIs:

```text
GET    /api/users
POST   /api/users/invitations
PATCH  /api/users/:userId
DELETE /api/users/:userId
```

Every operation must remain tenant-scoped.

Example:

```text
Organisation A Admin
        |
        +-- Update User A -> allowed
        |
        +-- Update User B from Organisation B -> denied
```

---

# 22. Platform Admin APIs

Platform admin endpoints should expose metadata only.

Example:

```http
GET /api/platform/organisations
```

Response:

```json
{
  "id": "org-123",
  "name": "Acme",
  "plan": "Professional",
  "usage": {
    "users": 12,
    "projects": 8,
    "tasks": 430
  }
}
```

It must not return:

```text
Task descriptions
Task comments
Project content
User passwords
Private organisation data
```

---

# 23. Platform Admin Boundary Test

Create:

```text
Organisation A
- Project
- Tasks
- Comments

Organisation B
- Project
- Tasks
- Comments
```

Authenticate as platform admin.

Platform admin should be able to:

```text
GET organisations
GET plan information
GET aggregate usage
```

But must not be able to:

```text
GET task details
GET project content
GET comments
GET tenant business data
```

This proves that platform-level visibility and tenant content access are
separate permissions.

---

# 24. Validation

All external input should be validated before business logic.

Use:

```text
Zod
```

Examples:

### Signup

Validate:

- Organisation name
- Email
- Password
- Required fields

### Task

Validate:

- Title
- Description
- Priority
- Status
- Assignee ID

### Plan

Validate:

- Plan ID
- Resource limits
- Numeric ranges

Invalid input should return a structured response.

Example:

```json
{
  "code": "VALIDATION_ERROR",
  "message": "Invalid request",
  "fields": {
    "email": "Invalid email address"
  }
}
```

---

# 25. API Error Strategy

Use consistent error responses.

Example:

```json
{
  "code": "PLAN_LIMIT_REACHED",
  "message": "Your current plan allows a maximum of 5 users."
}
```

Suggested error codes:

```text
VALIDATION_ERROR
UNAUTHENTICATED
FORBIDDEN
RESOURCE_NOT_FOUND
TENANT_ACCESS_DENIED
PLAN_LIMIT_REACHED
RESOURCE_ALREADY_EXISTS
INVITATION_EXPIRED
CONFLICT
INTERNAL_ERROR
```

---

# 26. Audit and Security Logging

Important events should generate structured logs.

Examples:

```text
ORGANISATION_CREATED
LOGIN_SUCCESS
LOGIN_FAILED
USER_INVITED
USER_REMOVED
PROJECT_CREATED
TASK_CREATED
PLAN_LIMIT_REACHED
CROSS_TENANT_ACCESS_ATTEMPT
PLATFORM_ADMIN_ACCESS
```

Example structured event:

```json
{
  "event": "CROSS_TENANT_ACCESS_ATTEMPT",
  "userId": "user-a",
  "organisationId": "org-a",
  "resourceType": "TASK",
  "resourceId": "task-b",
  "timestamp": "..."
}
```

Do not log passwords, access tokens, or sensitive secrets.

---

# 27. Performance Requirements

The application must not load all tenant data into memory and then
filter it.

Bad:

```text
SELECT * FROM tasks

JavaScript:
tasks.filter(task => task.organisationId === tenantId)
```

Good:

```text
SELECT ...
FROM tasks
WHERE organisation_id = tenant_id
```

Use database-level filtering and pagination.

---

# 28. Pagination

Organisation and resource lists should support pagination.

Example:

```http
GET /api/projects?page=1&limit=20
```

Response:

```json
{
  "items": [],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 120,
    "totalPages": 6
  }
}
```

Do not load the entire dataset into memory.

---

# 29. Database Indexing

Indexes should support common tenant-scoped queries.

Potential indexes:

```text
User:
(organisationId)

Project:
(organisationId)
(organisationId, key)

Task:
(organisationId)
(organisationId, projectId)
(organisationId, assigneeId)
(organisationId, status)

Comment:
(organisationId, taskId)
```

The exact indexes should be validated against actual query patterns.

---

# 30. API Surface

A possible API structure:

## Authentication

```text
POST /api/auth/signup
POST /api/auth/login
POST /api/auth/logout
GET  /api/auth/me
```

## Organisation

```text
GET   /api/organisation
PATCH /api/organisation
GET   /api/organisation/usage
```

## Users

```text
GET    /api/users
POST   /api/users/invitations
PATCH  /api/users/:userId
DELETE /api/users/:userId
```

## Projects

```text
GET    /api/projects
POST   /api/projects
GET    /api/projects/:projectId
PATCH  /api/projects/:projectId
DELETE /api/projects/:projectId
```

## Tasks

```text
GET    /api/tasks
POST   /api/projects/:projectId/tasks
GET    /api/tasks/:taskId
PATCH  /api/tasks/:taskId
DELETE /api/tasks/:taskId
```

## Comments

```text
GET    /api/tasks/:taskId/comments
POST   /api/tasks/:taskId/comments
DELETE /api/comments/:commentId
```

## Platform Admin

```text
GET /api/platform/organisations
GET /api/platform/organisations/:organisationId/usage
```

The exact routes can change based on implementation decisions.

---

# 31. Frontend Application

The frontend should demonstrate the backend capabilities without
becoming the main focus of the POC.

## Main screens

### Authentication

- Login
- Organisation signup
- Accept invitation

### Organisation

- Dashboard
- Usage
- Users
- Organisation settings

### Project Management

- Project list
- Project details
- Task board
- Task details

### Task

- Task title
- Description
- Status
- Priority
- Assignee
- Comments
- Activity/audit information where appropriate

### Platform Admin

- Organisation list
- Plan
- Usage
- Organisation status

The platform admin UI should not provide any tenant content screens.

---

# 32. Suggested Task Board

A simple Kanban-style board:

```text
TODO
 |
 +-- Task 1
 +-- Task 2

IN PROGRESS
 |
 +-- Task 3

IN REVIEW
 |
 +-- Task 4

DONE
 |
 +-- Task 5
```

Drag-and-drop can be optional. A status dropdown is sufficient for the
POC.

---

# 33. Two-Week Implementation Plan

## Day 1 --- Project Setup

- Create repository
- Setup pnpm workspace if required
- Setup React application
- Setup Express API
- Setup PostgreSQL
- Setup Prisma
- Setup Docker Compose
- Setup environment variables
- Setup linting/formatting
- Setup basic CI

Deliverable:

```text
docker compose up
```

starts the required infrastructure.

---

## Day 2 --- Database and Prisma

Implement:

- Organisation
- User
- Plan
- Project
- Task
- Comment
- Invitation
- AuditLog

Create:

- Prisma schema
- Migrations
- Seed data

Seed:

```text
Platform Admin
Organisation A
Organisation B
Users
Plans
Projects
Tasks
Comments
```

---

## Day 3 --- Authentication

Implement:

- Signup
- Login
- Password hashing
- JWT
- Authentication middleware
- Current-user endpoint

Test:

```text
Unauthenticated request -> 401
Authenticated request -> allowed
```

---

## Day 4 --- Tenant Context

Implement:

- Tenant resolution
- Request-scoped tenant context
- Tenant-aware repositories/data access
- Authorization middleware

This is one of the most important days of the POC.

---

## Day 5 --- Organisation and User Management

Implement:

- Organisation profile
- User list
- Invite user
- Remove user
- Role assignment

Add plan user-limit enforcement.

---

## Day 6 --- Projects

Implement:

- Create project
- List projects
- Get project
- Update project
- Delete/archive project

All project queries must be tenant-scoped.

---

## Day 7 --- Tasks

Implement:

- Create task
- List tasks
- Task details
- Update task
- Delete task
- Assign task
- Change status
- Change priority

---

## Day 8 --- Comments and Usage

Implement:

- Task comments
- Organisation usage
- Plan information
- Usage calculation
- Plan-limit checks

---

## Day 9 --- Platform Admin

Implement:

- Organisation list
- Plan information
- Aggregate usage
- Organisation status

Explicitly prevent tenant-content access.

---

## Day 10 --- Concurrency and Security

Implement/test:

- Concurrent user invites
- Plan-limit transaction
- Cross-tenant resource access
- Cross-tenant task assignment
- Cross-tenant user modification
- Platform admin content boundary

---

## Day 11 --- Frontend

Build:

- Login
- Signup
- Dashboard
- Project list
- Task board
- Task details
- Users
- Usage
- Platform admin screens

---

## Day 12 --- Validation and Error Handling

Add:

- Zod validation
- Standard error format
- Authentication errors
- Authorization errors
- Plan-limit errors
- Not-found handling
- Conflict handling

---

## Day 13 --- Testing and Observability

Add:

- Unit tests
- Integration tests
- API tests
- Cross-tenant security tests
- Concurrency tests
- Platform-admin boundary tests
- Structured audit/security logs

---

## Day 14 --- Documentation and Walkthrough

Prepare:

- Architecture diagram
- Database diagram
- API documentation
- Tenant-isolation explanation
- Security test demonstration
- Concurrency demonstration
- Docker setup
- `.env.example`
- README
- Known limitations
- Future improvements

---

# 34. Critical Test Suite

The following tests are mandatory.

## Test 1 --- Cross-Tenant Read

```text
User A
   |
   +-- GET Task B
          |
          v
       DENIED
```

---

## Test 2 --- Cross-Tenant Update

```text
User A
   |
   +-- PATCH Task B
          |
          v
       DENIED
```

---

## Test 3 --- Cross-Tenant User Management

```text
Org A Admin
   |
   +-- DELETE User B
          |
          v
       DENIED
```

---

## Test 4 --- Cross-Tenant Assignment

```text
Task A
Assignee B

=> DENIED
```

---

## Test 5 --- Platform Admin Content Boundary

```text
Platform Admin
   |
   +-- Organisation metadata -> ALLOWED
   |
   +-- Usage -> ALLOWED
   |
   +-- Task content -> DENIED
```

---

## Test 6 --- Plan Limit

```text
Limit = 5
Current = 5

Invite
  |
  v
409 PLAN_LIMIT_REACHED
```

---

## Test 7 --- Concurrent Plan Limit

```text
Limit = 5
Current = 4

Request A ----\
               +--> only one succeeds
Request B ----/
```

Assert:

```text
success count = 1
failure count = 1
final user count = 5
```

---

## Test 8 --- Invalid Input

Examples:

```text
Malformed email
Invalid role
Invalid project ID
Invalid plan ID
Missing task title
Invalid task status
```

All must be rejected before business logic executes.

---

## Test 9 --- Authentication

```text
No token -> 401
Invalid token -> 401
Valid token -> authenticated
```

---

## Test 10 --- Tenant Context Bypass

Create a deliberately careless data-access path and prove that it cannot
expose another tenant's resource.

This is a key walkthrough demonstration.

---

# 35. Seed Data

The development database should contain at least:

```text
Platform Admin

Organisation A
- Admin A
- Member A
- Project A
- Tasks A1/A2

Organisation B
- Admin B
- Member B
- Project B
- Tasks B1/B2
```

This makes cross-tenant testing easy to demonstrate.

---

# 36. Docker Compose

The entire application should start with:

```bash
docker compose up
```

Expected services:

```text
frontend
backend
postgres
```

Optional:

```text
adminer
```

The application should not require manual database creation.

Use Prisma migrations automatically as part of the documented setup.

---

# 37. Environment Variables

Provide:

```text
.env.example
```

Example:

```env
DATABASE_URL=
JWT_SECRET=
JWT_EXPIRES_IN=
PORT=
FRONTEND_URL=
```

Never commit real secrets.

---

# 38. Project Structure

Suggested backend structure:

```text
backend/
├── src/
│   ├── config/
│   ├── middleware/
│   │   ├── auth/
│   │   ├── tenant/
│   │   └── validation/
│   ├── modules/
│   │   ├── auth/
│   │   ├── organisations/
│   │   ├── users/
│   │   ├── plans/
│   │   ├── projects/
│   │   ├── tasks/
│   │   ├── comments/
│   │   └── platform/
│   ├── repositories/
│   ├── services/
│   ├── utils/
│   ├── app.ts
│   └── server.ts
├── prisma/
│   ├── schema.prisma
│   ├── migrations/
│   └── seed.ts
└── tests/
```

Frontend:

```text
frontend/
├── src/
│   ├── app/
│   ├── components/
│   ├── features/
│   │   ├── auth/
│   │   ├── dashboard/
│   │   ├── projects/
│   │   ├── tasks/
│   │   ├── users/
│   │   └── platform/
│   ├── routes/
│   ├── services/
│   ├── hooks/
│   └── types/
```

---

# 39. Architecture Diagram

High-level architecture:

```text
                    ┌─────────────────────┐
                    │      React UI       │
                    └──────────┬──────────┘
                               │
                               v
                    ┌─────────────────────┐
                    │   Express API       │
                    └──────────┬──────────┘
                               │
                    ┌──────────v──────────┐
                    │ Authentication       │
                    │ + Authorization      │
                    └──────────┬──────────┘
                               │
                    ┌──────────v──────────┐
                    │ Tenant Context       │
                    └──────────┬──────────┘
                               │
                    ┌──────────v──────────┐
                    │ Tenant-aware Data    │
                    │ Access Layer         │
                    └──────────┬──────────┘
                               │
                    ┌──────────v──────────┐
                    │ Prisma ORM           │
                    └──────────┬──────────┘
                               │
                    ┌──────────v──────────┐
                    │ PostgreSQL           │
                    └─────────────────────┘
```

---

# 40. Key Architecture Decisions to Document

Before final walkthrough, document the following decisions.

## Tenant Context

Answer:

```text
Where does tenantId come from?
```

Expected:

```text
Authenticated user/session
```

Not:

```text
Client-provided organisationId
```

---

## Tenant Enforcement

Answer:

```text
Where is tenant isolation enforced?
```

Document:

- Middleware
- Request context
- Repository/data-access layer
- Database query behavior

---

## Cross-Tenant Access

Answer:

```text
What happens if a resource ID belongs to another tenant?
```

Expected:

```text
Resource is not returned.
Attempt is logged.
```

---

## Plan Limit Concurrency

Answer:

```text
How do you prevent two requests from exceeding the limit simultaneously?
```

Document the PostgreSQL transaction/locking strategy.

---

## Platform Admin Boundary

Answer:

```text
How can platform admins see usage without seeing content?
```

Document separate authorization and query paths.

---

# 41. Definition of Done

The POC is complete when:

- [ ] Organisation signup works
- [ ] First admin user is created
- [ ] Login works
- [ ] Authentication is enforced
- [ ] Organisation context is resolved server-side
- [ ] Users are tenant-scoped
- [ ] Projects are tenant-scoped
- [ ] Tasks are tenant-scoped
- [ ] Comments are tenant-scoped
- [ ] Cross-tenant reads are blocked
- [ ] Cross-tenant writes are blocked
- [ ] Cross-tenant assignments are blocked
- [ ] Org admins can manage their own users
- [ ] Plans are assigned to organisations
- [ ] Plan limits are enforced
- [ ] Concurrent requests cannot bypass limits
- [ ] Platform admins can view organisation metadata
- [ ] Platform admins cannot view tenant content
- [ ] Input validation exists
- [ ] Structured audit/security logs exist
- [ ] Pagination exists for large lists
- [ ] Database queries filter at database level
- [ ] Required indexes exist
- [ ] Automated security tests exist
- [ ] Concurrency test exists
- [ ] Docker Compose works
- [ ] `.env.example` exists
- [ ] README is complete
- [ ] Architecture decisions are documented

---

# 42. Optional Deep-Dive Work

If the core implementation is complete early, do not add unrelated
features.

Instead, deepen the existing architecture.

## Option 1 --- Deliberately Unsafe Query

Create:

```text
GET /api/reports/tasks/:taskId
```

with an intentionally careless query.

Demonstrate whether the architecture:

- structurally prevents the leak, or
- detects the problem through tests.

---

## Option 2 --- 50 Concurrent Requests

Organisation:

```text
Limit = 5
Current = 3
```

Send:

```text
50 concurrent invite requests
```

Expected:

```text
2 succeed
48 fail
```

Final count:

```text
5
```

---

## Option 3 --- Tenant Integrity Scanner

Create an internal validation query that detects broken relationships
such as:

```text
Task.organisationId != Project.organisationId
```

or:

```text
Comment.organisationId != Task.organisationId
```

Seed an intentionally broken record and demonstrate that the scanner
detects it.

---

# 43. Final Walkthrough Flow

The recommended walkthrough should follow the most important
architectural risks first.

## Step 1 --- Show the Architecture

Explain:

```text
Authentication
      ↓
Tenant Context
      ↓
Authorization
      ↓
Tenant-aware Data Access
      ↓
Prisma
      ↓
PostgreSQL
```

---

## Step 2 --- Show Two Organisations

```text
Organisation A
Organisation B
```

Show users and tasks belonging to each.

---

## Step 3 --- Prove Cross-Tenant Isolation

Login as Organisation A.

Try to access Organisation B's task using the actual task ID.

Show:

```text
Access denied / resource not found
```

Then show the automated test.

---

## Step 4 --- Show the Careless Query

Demonstrate what happens when a developer creates a query without
manually adding a tenant filter.

Explain why the architecture prevents or exposes the problem.

---

## Step 5 --- Show Platform Admin

Demonstrate:

```text
Organisation list
Plan
Usage
```

Then demonstrate that tenant content cannot be accessed.

---

## Step 6 --- Show Plan Limit

Show:

```text
Plan limit = 5
Current users = 5
```

Attempt invite.

Show:

```text
PLAN_LIMIT_REACHED
```

---

## Step 7 --- Show Concurrency

Start with:

```text
Limit = 5
Current = 4
```

Fire two requests simultaneously.

Show:

```text
1 success
1 rejection
Final count = 5
```

---

## Step 8 --- Show Logs

Show structured events for:

```text
Plan limit rejection
Cross-tenant access attempt
Organisation creation
```

---

# 44. Main POC Objective

The application is a **Jira/Zoho-style task management system**, but the
actual engineering objective is:

> Build a multi-tenant architecture where tenant isolation,
> authorization, plan enforcement, and concurrency safety are enforced
> by the system design rather than relying on individual developers to
> remember security rules in every feature.

The task-management domain provides realistic entities and workflows to
demonstrate those architectural guarantees.
