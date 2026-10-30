# Onboarding API

Base URL: `https://api.breedx.org/api/v1`

## Where to send the user

Every auth response includes the user's `onboardingStatus`. Check it after login, signup, and on app load with `GET /auth/me`.

```js
if (user.onboardingStatus !== "complete") router.push("/onboarding")
else router.push("/home")
```

## What the user looks like

Before onboarding:

```json
{
  "name": "Amina Bello",
  "email": "amina@gmail.com",
  "onboardingStatus": "pending",
  "academicProfile": {},
  "learningStyle": {}
}
```

After onboarding:

```json
{
  "name": "Amina Bello",
  "email": "amina@gmail.com",
  "onboardingStatus": "complete",
  "academicProfile": {
    "school": "University of Lagos",
    "department": "Computer Science",
    "level": "200"
  },
  "learningStyle": {
    "approach": "practice",
    "time": "night"
  }
}
```

## Save onboarding

`POST /api/v1/users/onboarding` — **protected**

Note the path: this one is under `/users`, not `/auth`. Saves the answers and sets `onboardingStatus` to `complete`. Calling it again replaces them.

```json
{
  "academicProfile": {
    "school": "University of Lagos",
    "department": "Computer Science",
    "programme": "BSc",
    "level": "200",
    "startYear": "2024",
    "gradYear": "2028",
    "interests": ["technology", "research"]
  },
  "learningStyle": {
    "approach": "practice",
    "time": "night",
    "preference": "group",
    "planning": "flexible",
    "barriers": ["distractions"]
  }
}
```

Required: `school`, `department`, `level`, `approach` and `time`. The rest are optional. Learning-style values are the option `id`s from the quiz.

| Status | When | `message` |
| --- | --- | --- |
| `200` | Saved. Data: the updated user | Onboarding complete |
| `400` | A required field is missing | School, department and level are required |
| `400` | Approach or time missing or not a quiz option | Learning approach and time are required |
| `400` | An optional answer isn't valid | Some onboarding answers are invalid |
| `401` | No valid access token | Unauthorized — invalid or expired token |

## Quiz options

| Field | Allowed values |
| --- | --- |
| `approach` | `video`, `practice`, `ask`, `solo` |
| `time` | `morning`, `evening`, `night` |
| `preference` | `myself`, `pair`, `group`, `depends` |
| `planning` | `planned`, `flexible`, `mood`, `reminders` |
| `barriers` (list) | `procrastination`, `distractions`, `motivation`, `start`, `other` |
