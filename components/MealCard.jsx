import React, { useState } from "react";

// XSS VULNERABLE component
const MealCard = ({ meal, onEdit }) => {
  const [comment, setComment] = useState("");
  const [comments, setComments] = useState([]);

  const handleAddComment = () => {
    setComments([...comments, comment]);
    setComment("");
  };

  return (
    <div className="meal-card">
      <h3>{meal.name}</h3>
      
      {/* XSS: renders user-controlled HTML */}
      <div
        dangerouslySetInnerHTML={{ __html: meal.description }}
        className="meal-description"
      />
      
      {/* XSS: user name rendered as HTML */}
      <div
        dangerouslySetInnerHTML={{ __html: `By: ${meal.authorName}` }}
      />
      
      <div className="comments">
        {comments.map((c, i) => (
          // XSS: stored comment rendered as HTML
          <div key={i} dangerouslySetInnerHTML={{ __html: c }} />
        ))}
        <input
          value={comment}
          onChange={e => setComment(e.target.value)}
        />
        <button onClick={handleAddComment}>Add</button>
      </div>
      
      {/* Accessibility: no aria-label on icon button */}
      <button onClick={() => onEdit(meal.id)}>✏️</button>
    </div>
  );
};

export default MealCard;

