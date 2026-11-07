# CGPA API

Base URL: `https://api.breedx.org/api/v1`. Every endpoint needs `Authorization: Bearer <access token>`.

A student has one academic record: their grading scale and every level, semester and course. The server works out each semester's GPA and the CGPA after it, so the app only draws the numbers.

All three endpoints answer with the same shape:

```json
{
  "success": true,
  "message": "Success",
  "data": {
    "scale": "5.0",
    "levels": [
      {
        "id": "8f1c…",
        "level": "100L",
        "session": "2022/2023",
        "semesters": {
          "first": [{ "id": "c1", "code": "EEE 301", "title": "Power Systems", "credits": "3", "grade": "A" }],
          "second": []
        }
      }
    ],
    "summary": {
      "cgpa": 4.58,
      "credits": 12,
      "periods": 3,
      "current": { "level": "200L", "which": "first", "session": "2023/2024" },
      "semesters": [
        { "levelId": "8f1c…", "level": "100L", "which": "first", "session": "2022/2023", "courses": 2, "credits": 6, "gpa": 4.5, "cgpa": 4.5 }
      ]
    },
    "updatedAt": "2026-11-07T10:00:00.000Z"
  }
}
```

- GPA = quality points ÷ credit units for one semester. CGPA = all quality points ÷ all credit units so far, in level order (100L first, then second semester).
- A course counts once it has credit units above 0 and a grade. Half-filled rows are kept but don't count.
- Results are rounded to 2 decimal places.
- A student with no record gets `scale: "5.0"`, no levels and zeros.

## Get the record

`GET /cgpa`

## Save the record

`PUT /cgpa/levels` replaces the whole record.

```json
{ "levels": [ { "id": "…", "level": "100L", "session": "2022/2023", "semesters": { "first": [], "second": [] } } ] }
```

Rules (break one and you get `400` with the reason):

- Up to 6 levels, from `100L` to `600L`, each level once.
- Up to 40 courses per semester.
- `credits` is `""` or a whole number from 0 to 30, sent as a string.
- `grade` is `""` or a grade on the current scale: A–F on 5.0, A–D and F on 4.0.

## Change the grading scale

`PATCH /cgpa/scale`

```json
{ "scale": "4.0" }
```

Every GPA and CGPA is worked out again on the new scale. Points: 5.0 → A 5, B 4, C 3, D 2, E 1, F 0. 4.0 → A 4, B 3, C 2, D 1, F 0.

Switching to 4.0 while the record still has E grades → `409`, `"Change the 2 grades the 4.0 scale doesn't use before switching"`, with `"unsupported": 2`.

Any other scale → `400`.
