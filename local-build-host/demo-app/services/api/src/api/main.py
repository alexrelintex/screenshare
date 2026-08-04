"""Minimal API. Deliberately boring: the point is the build/test loop around it."""

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI(title="demo-api", version="0.1.0")


class SumRequest(BaseModel):
    values: list[float]


class SumResponse(BaseModel):
    total: float
    count: int


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/sum", response_model=SumResponse)
def sum_values(req: SumRequest) -> SumResponse:
    if not req.values:
        raise HTTPException(status_code=422, detail="values must not be empty")
    return SumResponse(total=float(sum(req.values)), count=len(req.values))
