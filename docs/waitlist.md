# Waitlist API

Base URL: `https://api.breedx.org/api/v1`

## Join the waitlist

`POST /waitlist`

```json
{ "email": "amina@gmail.com" }
```

New email → `201`, and a confirmation email is sent:

```json
{
  "success": true,
  "message": "You're on the waitlist",
  "data": { "email": "amina@gmail.com", "count": 128, "alreadyJoined": false }
}
```

Same email again → `200`, `"alreadyJoined": true`, no second email.

Bad email → `400`, `"Enter a valid email address"`.

## How many people have joined

`GET /waitlist/count`

```json
{ "success": true, "message": "Success", "data": { "count": 128 } }
```
